import { ApplicationError } from '../../../platform/http/application-error';
import type { ContentScope, UploadCreateInput, UploadOwnerType } from '../files.types';

const publicOwnerTypes = new Set<UploadOwnerType>([
  'profile',
  'resume',
  'team',
  'opportunity',
  'event',
]);

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function validateUploadPolicy(
  input: UploadCreateInput,
  maxUploadBytes = MAX_UPLOAD_BYTES,
): void {
  if (input.sizeBytes < 1 || input.sizeBytes > maxUploadBytes) {
    throw new ApplicationError(
      'UPLOAD_LIMIT_EXCEEDED',
      'Файл превышает допустимый размер 5 МБ.',
      413,
    );
  }
  if (
    (input.contentScope === 'private_message' && input.ownerType !== 'message_draft') ||
    (input.contentScope === 'public_content' && !publicOwnerTypes.has(input.ownerType))
  ) {
    throw new ApplicationError(
      'UPLOAD_SCOPE_MISMATCH',
      'Тип владельца не соответствует назначению изображения.',
      422,
    );
  }
}

export function retentionClassFor(
  ownerType: UploadOwnerType,
):
  | 'message_photo'
  | 'profile_asset'
  | 'resume_asset'
  | 'team_asset'
  | 'opportunity_asset'
  | 'event_asset' {
  if (ownerType === 'message_draft') return 'message_photo';
  return `${ownerType}_asset` as
    'profile_asset' | 'resume_asset' | 'team_asset' | 'opportunity_asset' | 'event_asset';
}

export function publicStateFor(
  scope: ContentScope,
  state: string,
):
  | 'created'
  | 'processing'
  | 'ready'
  | 'moderation_pending'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'consumed' {
  if (state === 'technically_ready')
    return scope === 'private_message' ? 'ready' : 'moderation_pending';
  return state as
    | 'created'
    | 'processing'
    | 'ready'
    | 'moderation_pending'
    | 'approved'
    | 'rejected'
    | 'failed'
    | 'expired'
    | 'consumed';
}
