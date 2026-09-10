export const MAX_MEDIA_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface PendingMediaUpload {
  uploadId: string;
  completeIdempotencyKey: string;
}

export function pendingMediaUploadKey(ownerType: string, ownerId: string): string {
  return `media-upload:${ownerType}:${ownerId}`;
}

export function savePendingMediaUpload(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  pending: PendingMediaUpload,
): void {
  storage.setItem(key, JSON.stringify(pending));
}

export function loadPendingMediaUpload(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): PendingMediaUpload | undefined {
  const value = storage.getItem(key);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<PendingMediaUpload>;
    if (typeof parsed.uploadId === 'string' && typeof parsed.completeIdempotencyKey === 'string') {
      return {
        uploadId: parsed.uploadId,
        completeIdempotencyKey: parsed.completeIdempotencyKey,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function isMediaReady(state: string): boolean {
  return state === 'ready' || state === 'moderation_pending' || state === 'approved';
}

export function mediaUploadError(code: string | undefined): string {
  switch (code) {
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 'Выберите изображение JPEG, PNG или WebP.';
    case 'UPLOAD_LIMIT_EXCEEDED':
    case 'PAYLOAD_TOO_LARGE':
      return 'Размер изображения не должен превышать 5 МБ.';
    case 'MEDIA_NOT_READY':
      return 'Изображение ещё обрабатывается. Повторите проверку позже.';
    case 'MEDIA_MALWARE_DETECTED':
      return 'Файл не прошёл проверку безопасности.';
    case 'MEDIA_PROCESSING_FAILED':
      return 'Изображение не удалось обработать. Выберите другой файл.';
    default:
      return 'Изображение не удалось загрузить. Повторите попытку.';
  }
}
