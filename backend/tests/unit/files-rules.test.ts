import { describe, expect, it } from 'vitest';
import { ApplicationError } from '../../src/platform/http/application-error';
import {
  publicStateFor,
  retentionClassFor,
  validateUploadPolicy,
} from '../../src/modules/files/domain/image-rules';

describe('files domain rules', () => {
  it('keeps private message scope separate from public owner types', () => {
    expect(() =>
      validateUploadPolicy({
        contentScope: 'private_message',
        ownerType: 'profile',
        ownerId: crypto.randomUUID(),
        mimeType: 'image/jpeg',
        sizeBytes: 10,
      }),
    ).toThrowError(ApplicationError);

    expect(() =>
      validateUploadPolicy({
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerId: crypto.randomUUID(),
        mimeType: 'image/jpeg',
        sizeBytes: 10,
      }),
    ).not.toThrow();
  });

  it('maps retention classes and public state without exposing internal state', () => {
    expect(retentionClassFor('profile')).toBe('profile_asset');
    expect(retentionClassFor('message_draft')).toBe('message_photo');
    expect(publicStateFor('private_message', 'technically_ready')).toBe('ready');
    expect(publicStateFor('public_content', 'technically_ready')).toBe('moderation_pending');
  });

  it('rejects a source larger than the configured limit', () => {
    expect(() =>
      validateUploadPolicy(
        {
          contentScope: 'public_content',
          ownerType: 'profile',
          ownerId: crypto.randomUUID(),
          mimeType: 'image/png',
          sizeBytes: 1025,
        },
        1024,
      ),
    ).toThrowError(ApplicationError);
  });
});
