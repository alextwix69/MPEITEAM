import { describe, expect, it } from 'vitest';
import { parseClamAvResponse } from '../../src/modules/files/infrastructure/malware-scanner.adapter';
import { S3StorageAdapter } from '../../src/modules/files/infrastructure/s3-storage.adapter';
import { assertStoredUploadMatches } from '../../src/modules/files/worker/files-worker.service';
import type { FilesEnvironment } from '../../src/modules/files/files.types';

const storageEnvironment = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'https://media.example.test',
  S3_REGION: 'ru-central-1',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
  S3_FORCE_PATH_STYLE: true,
} as FilesEnvironment;

describe('files security regressions', () => {
  it('uses the browser-reachable endpoint and forces no-store on signed downloads', async () => {
    const storage = new S3StorageAdapter(storageEnvironment);
    const upload = new URL(
      await storage.createUploadUrl({
        objectKey: 'quarantine/a/b',
        contentType: 'image/png',
        contentLength: 10,
        expiresInSeconds: 60,
      }),
    );
    const download = new URL(
      await storage.createDownloadUrl({ objectKey: 'media/a.jpg', expiresInSeconds: 60 }),
    );

    expect(upload.origin).toBe('https://media.example.test');
    expect(upload.searchParams.get('X-Amz-SignedHeaders')).not.toContain('content-length');
    expect(download.origin).toBe('https://media.example.test');
    expect(download.searchParams.get('response-cache-control')).toBe('no-store');
    storage.onApplicationShutdown();
  });

  it('treats any ClamAV FOUND response as malware, not only EICAR', () => {
    expect(parseClamAvResponse('stream: Win.Test.SomeOtherSignature FOUND\0')).toBe('malware');
    expect(parseClamAvResponse('stream: OK\0')).toBe('clean');
    expect(() => parseClamAvResponse('stream: scanner error\0')).toThrow();
  });

  it('revalidates metadata and bytes immediately before processing', () => {
    expect(() =>
      assertStoredUploadMatches(
        { contentLength: 10, contentType: 'image/png', eTag: 'old' },
        { contentLength: 10, contentType: 'image/png', eTag: 'new' },
        9,
        10,
        'image/png',
        'old',
      ),
    ).toThrowError(/соответствует/u);
    expect(() =>
      assertStoredUploadMatches(
        { contentLength: 10, contentType: 'image/png', eTag: 'same' },
        { contentLength: 10, contentType: 'image/png', eTag: 'same' },
        10,
        10,
        'image/png',
        'same',
      ),
    ).not.toThrow();
  });
});
