import { describe, expect, it } from 'vitest';
import {
  isMediaReady,
  loadPendingMediaUpload,
  mediaUploadError,
  MAX_MEDIA_UPLOAD_BYTES,
  savePendingMediaUpload,
} from '../src/lib/media-upload';

describe('media upload UI rules', () => {
  it('allows only server-ready states to show a preview', () => {
    expect(isMediaReady('processing')).toBe(false);
    expect(isMediaReady('moderation_pending')).toBe(true);
    expect(isMediaReady('ready')).toBe(true);
    expect(isMediaReady('approved')).toBe(true);
  });

  it('keeps the client limit aligned with the API contract', () => {
    expect(MAX_MEDIA_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  });

  it('maps safe business errors to Russian next actions', () => {
    expect(mediaUploadError('UNSUPPORTED_MEDIA_TYPE')).toContain('JPEG');
    expect(mediaUploadError('MEDIA_NOT_READY')).toContain('обрабатывается');
    expect(mediaUploadError('unknown')).toContain('Повторите');
  });

  it('persists only the upload id and the same completion idempotency key', () => {
    let serialized = '';
    savePendingMediaUpload({ setItem: (_key, value) => (serialized = value) }, 'pending', {
      uploadId: 'upload-1',
      completeIdempotencyKey: 'stable-key',
    });

    expect(serialized).not.toContain('uploadUrl');
    expect(loadPendingMediaUpload({ getItem: () => serialized }, 'pending')).toEqual({
      uploadId: 'upload-1',
      completeIdempotencyKey: 'stable-key',
    });
  });
});
