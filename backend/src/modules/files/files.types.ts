import type { ApiEnvironment, WorkerEnvironment } from '../../platform/config/env.schema';

export type FilesEnvironment = Pick<
  ApiEnvironment | WorkerEnvironment,
  | 'S3_ENDPOINT'
  | 'S3_PUBLIC_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY'
  | 'S3_SECRET_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'FILES_UPLOAD_TTL_SECONDS'
  | 'FILES_DOWNLOAD_TTL_SECONDS'
  | 'FILES_QUARANTINE_TTL_SECONDS'
  | 'FILES_WORKER_INTERVAL_MS'
  | 'FILES_MAX_SIZE_BYTES'
  | 'FILES_MAX_OUTPUT_BYTES'
  | 'FILES_SCANNER_HOST'
  | 'FILES_SCANNER_PORT'
  | 'FILES_SCANNER_TIMEOUT_MS'
  | 'AUTH_TOKEN_ENCRYPTION_KEY'
  | 'REDIS_URL'
  | 'DEPENDENCY_TIMEOUT_MS'
  | 'IDEMPOTENCY_HMAC_KEY'
  | 'RATE_LIMIT_WINDOW_SECONDS'
  | 'RATE_LIMIT_MAX_REQUESTS'
>;

export const uploadMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type UploadMimeType = (typeof uploadMimeTypes)[number];

export const uploadOwnerTypes = [
  'profile',
  'resume',
  'team',
  'opportunity',
  'event',
  'message_draft',
] as const;
export type UploadOwnerType = (typeof uploadOwnerTypes)[number];

export type ContentScope = 'private_message' | 'public_content';
export type PublicUploadState =
  | 'created'
  | 'processing'
  | 'ready'
  | 'moderation_pending'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'consumed';

export interface UploadCreateInput {
  contentScope: ContentScope;
  ownerType: UploadOwnerType;
  ownerId: string;
  mimeType: UploadMimeType;
  sizeBytes: number;
}

export interface UploadSessionView {
  id: string;
  contentScope: ContentScope;
  state: PublicUploadState;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  mediaId?: string;
  expiresAt: string;
  failureCode?: string;
}

export interface DownloadUrlView {
  url: string;
  expiresAt: string;
}

export interface PublicMediaBindingInput {
  accountId: string;
  mediaId: string;
  ownerType: 'profile' | 'resume';
  ownerId: string;
  versionType: 'profile_version' | 'resume_version';
  versionId: string;
}

export interface SanitizedImage {
  body: Buffer;
  mime: 'image/jpeg';
  sizeBytes: number;
  width: number;
  height: number;
}
