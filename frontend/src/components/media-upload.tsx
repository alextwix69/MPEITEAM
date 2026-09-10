'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { apiClient } from '../lib/api/client';
import {
  isMediaReady,
  loadPendingMediaUpload,
  mediaUploadError,
  MAX_MEDIA_UPLOAD_BYTES,
  pendingMediaUploadKey,
  savePendingMediaUpload,
  type PendingMediaUpload,
} from '../lib/media-upload';
import { useSession } from './session-provider';
import { Button } from './ui/button';

type UploadOwnerType = 'profile' | 'resume' | 'team' | 'opportunity' | 'event' | 'message_draft';
type ContentScope = 'private_message' | 'public_content';

export interface MediaUploadProps {
  contentScope: ContentScope;
  ownerType: UploadOwnerType;
  ownerId: string;
  onReady?: (mediaId: string, downloadUrl?: string) => void;
}

const POLL_ATTEMPTS = 20;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function MediaUpload({ contentScope, ownerType, ownerId, onReady }: MediaUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { session } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [pending, setPending] = useState<PendingMediaUpload>();
  const resumedKeyRef = useRef<string | undefined>(undefined);
  const storageKey = useMemo(() => pendingMediaUploadKey(ownerType, ownerId), [ownerId, ownerType]);

  const finishUpload = useCallback(
    async (candidate: PendingMediaUpload): Promise<void> => {
      if (!session) return;
      setBusy(true);
      setMessage('');
      try {
        const complete = await apiClient.POST('/uploads/{uploadId}/complete', {
          params: {
            path: { uploadId: candidate.uploadId },
            header: {
              'X-CSRF-Token': session.csrfToken,
              'Idempotency-Key': candidate.completeIdempotencyKey,
            },
          },
        });
        if (complete.error) {
          setMessage(mediaUploadError(complete.error.error.code));
          return;
        }

        let mediaId = complete.data?.mediaId;
        for (let attempt = 0; attempt < POLL_ATTEMPTS && !mediaId; attempt += 1) {
          const status = await apiClient.GET('/uploads/{uploadId}', {
            params: { path: { uploadId: candidate.uploadId } },
            cache: 'no-store',
          });
          if (status.error || !status.data) {
            setMessage(mediaUploadError(status.error?.error.code));
            return;
          }
          if (status.data.state === 'failed' || status.data.state === 'rejected') {
            sessionStorage.removeItem(storageKey);
            setPending(undefined);
            setMessage(mediaUploadError(status.data.failureCode));
            return;
          }
          if (isMediaReady(status.data.state) && status.data.mediaId) mediaId = status.data.mediaId;
          if (!mediaId) await wait(500);
        }
        if (!mediaId) {
          setMessage(mediaUploadError('MEDIA_NOT_READY'));
          return;
        }
        if (contentScope === 'public_content') {
          sessionStorage.removeItem(storageKey);
          setPending(undefined);
          setMessage('Изображение загружено и будет опубликовано только после проверки.');
          onReady?.(mediaId);
          return;
        }
        const download = await apiClient.GET('/media/{mediaId}/download-url', {
          params: { path: { mediaId } },
          cache: 'no-store',
        });
        if (download.error || !download.data) {
          setMessage(mediaUploadError(download.error?.error.code));
          return;
        }
        sessionStorage.removeItem(storageKey);
        setPending(undefined);
        setPreviewUrl(download.data.url);
        onReady?.(mediaId, download.data.url);
      } catch {
        setMessage('Связь прервалась. Повторите завершение загрузки.');
      } finally {
        setBusy(false);
      }
    },
    [contentScope, onReady, session, storageKey],
  );

  useEffect(() => {
    if (!session) return;
    const saved = loadPendingMediaUpload(sessionStorage, storageKey);
    if (!saved || resumedKeyRef.current === storageKey) return;
    resumedKeyRef.current = storageKey;
    setPending(saved);
    void finishUpload(saved);
  }, [finishUpload, session, storageKey]);

  async function upload(file: File): Promise<void> {
    if (!session) {
      setMessage('Войдите в аккаунт, чтобы загрузить изображение.');
      return;
    }
    if (file.size < 1 || file.size > MAX_MEDIA_UPLOAD_BYTES) {
      setMessage(mediaUploadError('UPLOAD_LIMIT_EXCEEDED'));
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMessage(mediaUploadError('UNSUPPORTED_MEDIA_TYPE'));
      return;
    }

    setBusy(true);
    setMessage('');
    setPreviewUrl(undefined);
    try {
      const body = {
        contentScope,
        ownerType,
        ownerId,
        mimeType: file.type as 'image/jpeg' | 'image/png' | 'image/webp',
        sizeBytes: file.size,
      };
      const create = await apiClient.POST('/uploads', {
        params: {
          header: { 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
        },
        body,
      });
      if (create.error || !create.data?.uploadUrl) {
        setMessage(mediaUploadError(create.error?.error.code));
        return;
      }
      const uploadResponse = await fetch(create.data.uploadUrl, {
        method: 'PUT',
        headers: create.data.uploadHeaders,
        body: file,
        referrerPolicy: 'no-referrer',
      });
      if (!uploadResponse.ok) {
        setMessage('Файл не удалось передать в хранилище. Повторите попытку.');
        return;
      }
      const candidate = {
        uploadId: create.data.id,
        completeIdempotencyKey: crypto.randomUUID(),
      };
      savePendingMediaUpload(sessionStorage, storageKey, candidate);
      setPending(candidate);
      await finishUpload(candidate);
    } catch {
      setMessage('Связь прервалась. Повторите загрузку.');
    } finally {
      setBusy(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void upload(file);
  }

  return (
    <section aria-label="Загрузка изображения" className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={onFileChange}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Обрабатываем…' : 'Выбрать изображение'}
      </Button>
      {pending && !busy && (
        <Button type="button" variant="secondary" onClick={() => void finishUpload(pending)}>
          Повторить завершение загрузки
        </Button>
      )}
      <p className="text-sm text-slate-600">JPEG, PNG или WebP, не более 5 МБ.</p>
      {message && <p role="alert">{message}</p>}
      {previewUrl && (
        // Signed object URLs are dynamic and intentionally bypass Next image optimization.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="Загруженное изображение" className="max-h-64 rounded-xl" />
      )}
    </section>
  );
}
