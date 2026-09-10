import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ApplicationError } from '../../src/platform/http/application-error';
import { sanitizeImage } from '../../src/modules/files/infrastructure/image-sanitizer';

const cleanScanner = { scan: async () => 'clean' as const };

async function sourceJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 16,
      height: 12,
      channels: 3,
      background: { r: 20, g: 80, b: 160 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

describe('image sanitizer', () => {
  it('validates magic bytes and re-encodes without EXIF', async () => {
    const sanitized = await sanitizeImage(await sourceJpeg(), 'image/jpeg', cleanScanner);
    const metadata = await sharp(sanitized.body).metadata();

    expect(sanitized.mime).toBe('image/jpeg');
    expect(sanitized.sizeBytes).toBe(sanitized.body.length);
    expect(sanitized.width).toBeLessThanOrEqual(1920);
    expect(sanitized.height).toBeLessThanOrEqual(1080);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('rejects spoofed MIME and malware verdicts', async () => {
    const source = await sourceJpeg();
    await expect(sanitizeImage(source, 'image/png', cleanScanner)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
    await expect(
      sanitizeImage(source, 'image/jpeg', { scan: async () => 'malware' as const }),
    ).rejects.toMatchObject({ code: 'MEDIA_MALWARE_DETECTED' });
  });

  it('fails closed for malformed bytes', async () => {
    await expect(
      sanitizeImage(Buffer.from('not-an-image'), 'image/jpeg', cleanScanner),
    ).rejects.toBeInstanceOf(ApplicationError);
  });
});
