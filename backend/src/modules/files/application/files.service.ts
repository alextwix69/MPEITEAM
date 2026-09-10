import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseService } from '../../../platform/database/database.service';
import { ApplicationError } from '../../../platform/http/application-error';
import { getRequestContext } from '../../../platform/http/request-context';
import {
  canonicalJson,
  decryptSecret,
  encryptSecret,
  sha256,
} from '../../../platform/security/crypto';
import { ProfilesService } from '../../profiles';
import { FILES_ENVIRONMENT, OBJECT_STORAGE, UPLOAD_RATE_LIMITER } from '../files.tokens';
import type {
  ContentScope,
  DownloadUrlView,
  FilesEnvironment,
  UploadCreateInput,
  UploadSessionView,
  PublicMediaBindingInput,
} from '../files.types';
import { publicStateFor, validateUploadPolicy } from '../domain/image-rules';
import { idempotencyKeySchema } from './files.schemas';
import type { ObjectStorage } from './object-storage.port';
import type { UploadRateLimiter } from './upload-rate-limiter.port';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_PREFIX = 'quarantine';

interface IdempotencyReplay {
  body: unknown;
  status: number;
}

function isSameBytes(left: Uint8Array, right: Buffer): boolean {
  return Buffer.from(left).equals(right);
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Optional()
    @Inject(UPLOAD_RATE_LIMITER)
    private readonly rateLimiter: UploadRateLimiter | undefined,
    @Inject(FILES_ENVIRONMENT) private readonly environment: FilesEnvironment,
  ) {}

  async createUploadSession(
    accountId: string,
    input: UploadCreateInput,
    idempotencyKey: string,
    ipAddress: string,
  ): Promise<{ body: UploadSessionView; replayed: boolean }> {
    validateUploadPolicy(input, this.environment.FILES_MAX_SIZE_BYTES);
    this.validateIdempotencyKey(idempotencyKey);
    if (!this.rateLimiter) throw new Error('UPLOAD_RATE_LIMITER_NOT_CONFIGURED');
    await this.rateLimiter.consume(accountId, ipAddress);
    await this.assertOwner(accountId, input.ownerType, input.ownerId);

    const requestHash = sha256(canonicalJson(input));
    const route = 'POST /uploads';
    const replay = await this.lookupIdempotency(accountId, route, idempotencyKey, requestHash);
    if (replay) return { body: replay.body as UploadSessionView, replayed: true };

    const id = uuidv7();
    const objectKey = `${QUARANTINE_PREFIX}/${uuidv7()}/${uuidv7()}`;
    const expiresAt = new Date(Date.now() + this.environment.FILES_UPLOAD_TTL_SECONDS * 1000);
    const correlationId = getRequestContext()?.correlationId ?? uuidv7();
    const eventId = uuidv7();
    const uploadUrl = await this.storage.createUploadUrl({
      objectKey,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
      expiresInSeconds: this.environment.FILES_UPLOAD_TTL_SECONDS,
    });
    const body: UploadSessionView = {
      id,
      contentScope: input.contentScope,
      state: 'created',
      uploadUrl,
      uploadHeaders: {
        'content-type': input.mimeType,
      },
      expiresAt: expiresAt.toISOString(),
    };

    return this.database.$transaction(async (transaction) => {
      const reservation = await this.reserveIdempotency(
        transaction,
        accountId,
        route,
        idempotencyKey,
        requestHash,
      );
      if (reservation) return { body: reservation.body as UploadSessionView, replayed: true };

      await transaction.uploadSession.create({
        data: {
          id,
          ownerAccountId: accountId,
          contentScope: input.contentScope,
          ownerType: input.ownerType,
          ownerRef: input.ownerId,
          expectedMime: input.mimeType,
          expectedSizeBytes: input.sizeBytes,
          objectKey,
          expiresAt,
          correlationId,
          eventId,
        },
      });
      await this.completeIdempotency(transaction, accountId, route, idempotencyKey, 201, body, id);
      return { body, replayed: false };
    });
  }

  async completeUpload(
    accountId: string,
    uploadId: string,
    idempotencyKey: string,
  ): Promise<{ body: UploadSessionView; replayed: boolean }> {
    this.validateIdempotencyKey(idempotencyKey);
    const request = { uploadId };
    const requestHash = sha256(canonicalJson(request));
    const route = 'POST /uploads/{uploadId}/complete';
    const replay = await this.lookupIdempotency(accountId, route, idempotencyKey, requestHash);
    if (replay) return { body: replay.body as UploadSessionView, replayed: true };

    const current = await this.database.uploadSession.findFirst({
      where: { id: uploadId, ownerAccountId: accountId },
    });
    if (!current) this.notFound('UPLOAD_NOT_FOUND', 'Загрузка не найдена.');
    if (current.expiresAt <= new Date() && ['created', 'uploaded'].includes(current.state)) {
      await this.database.uploadSession.updateMany({
        where: { id: uploadId, ownerAccountId: accountId, state: { in: ['created', 'uploaded'] } },
        data: {
          state: 'expired',
          failureCode: 'UPLOAD_EXPIRED',
          rowVersion: { increment: 1 },
        },
      });
      throw new ApplicationError(
        'UPLOAD_EXPIRED',
        'Срок загрузки истёк. Начните загрузку заново.',
        409,
      );
    }

    let objectMetadata: Awaited<ReturnType<ObjectStorage['head']>>;
    let verifiedEtag: string | undefined;
    if (current.state === 'created' || current.state === 'uploaded') {
      objectMetadata = await this.storage.head(current.objectKey);
      if (
        !objectMetadata ||
        objectMetadata.contentLength !== current.expectedSizeBytes ||
        !objectMetadata.eTag
      ) {
        throw new ApplicationError(
          'UPLOAD_OBJECT_MISMATCH',
          'Переданный файл не соответствует заявленным параметрам.',
          409,
        );
      }
      if (objectMetadata.contentType !== current.expectedMime) {
        throw new ApplicationError(
          'UPLOAD_OBJECT_MISMATCH',
          'Переданный файл не соответствует заявленному формату.',
          409,
        );
      }
      verifiedEtag = objectMetadata.eTag;
    }

    try {
      return await this.database.$transaction(async (transaction) => {
        const reservation = await this.reserveIdempotency(
          transaction,
          accountId,
          route,
          idempotencyKey,
          requestHash,
        );
        if (reservation) return { body: reservation.body as UploadSessionView, replayed: true };

        const session = await transaction.uploadSession.findFirst({
          where: { id: uploadId, ownerAccountId: accountId },
        });
        if (!session) this.notFound('UPLOAD_NOT_FOUND', 'Загрузка не найдена.');
        let body: UploadSessionView;
        if (session.state === 'created' || session.state === 'uploaded') {
          if (!verifiedEtag) {
            throw new ApplicationError(
              'UPLOAD_OBJECT_MISMATCH',
              'Переданный файл изменился во время проверки.',
              409,
            );
          }
          if (session.expiresAt <= new Date()) {
            throw new ApplicationError(
              'UPLOAD_EXPIRED',
              'Срок загрузки истёк. Начните загрузку заново.',
              409,
            );
          }
          const transitioned = await transaction.uploadSession.updateMany({
            where: {
              id: session.id,
              ownerAccountId: accountId,
              state: { in: ['created', 'uploaded'] },
              expiresAt: { gt: new Date() },
              rowVersion: session.rowVersion,
            },
            data: {
              state: 'processing',
              failureCode: null,
              sourceEtag: verifiedEtag,
              rowVersion: { increment: 1 },
            },
          });
          if (transitioned.count === 1) {
            body = {
              id: session.id,
              contentScope: session.contentScope,
              state: 'processing',
              expiresAt: session.expiresAt.toISOString(),
            };
          } else {
            const concurrent = await transaction.uploadSession.findUniqueOrThrow({
              where: { id: session.id },
            });
            if (
              concurrent.expiresAt <= new Date() &&
              ['created', 'uploaded'].includes(concurrent.state)
            ) {
              throw new ApplicationError(
                'UPLOAD_EXPIRED',
                'Срок загрузки истёк. Начните загрузку заново.',
                409,
              );
            }
            body = await this.toView(concurrent);
          }
        } else {
          body = await this.toView(session);
        }
        await this.completeIdempotency(
          transaction,
          accountId,
          route,
          idempotencyKey,
          202,
          body,
          uploadId,
        );
        return { body, replayed: false };
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'UPLOAD_EXPIRED') {
        await this.database.uploadSession.updateMany({
          where: {
            id: uploadId,
            ownerAccountId: accountId,
            state: { in: ['created', 'uploaded'] },
            expiresAt: { lte: new Date() },
          },
          data: {
            state: 'expired',
            failureCode: 'UPLOAD_EXPIRED',
            rowVersion: { increment: 1 },
          },
        });
      }
      throw error;
    }
  }

  async getUploadSession(accountId: string, uploadId: string): Promise<UploadSessionView> {
    const session = await this.database.uploadSession.findFirst({
      where: { id: uploadId, ownerAccountId: accountId },
    });
    if (!session) this.notFound('UPLOAD_NOT_FOUND', 'Загрузка не найдена.');
    return this.toView(session);
  }

  async createDownloadUrl(accountId: string, mediaId: string): Promise<DownloadUrlView> {
    const media = await this.database.mediaObject.findUnique({ where: { id: mediaId } });
    const canReadPublished =
      media?.contentScope === 'public_content' &&
      ['approved', 'attached'].includes(media.state) &&
      (await this.profiles.isPublishedMedia(mediaId));
    if (!media || (media.uploaderAccountId !== accountId && !canReadPublished)) {
      this.notFound('MEDIA_NO_LONGER_STORED', 'Изображение больше недоступно.');
    }
    if (media.state === 'deleting' || media.state === 'deleted') {
      this.notFound('MEDIA_NO_LONGER_STORED', 'Изображение больше недоступно.');
    }
    const downloadable =
      media.state === 'technically_ready' ||
      media.state === 'approved' ||
      media.state === 'attached';
    if (
      !downloadable ||
      (media.contentScope === 'public_content' && media.state === 'technically_ready')
    ) {
      throw new ApplicationError(
        'MEDIA_NOT_READY',
        'Изображение ещё не готово для просмотра.',
        409,
        true,
      );
    }
    if (!media.objectKey) {
      this.notFound('MEDIA_NO_LONGER_STORED', 'Изображение больше недоступно.');
    }
    const exists = await this.storage.head(media.objectKey);
    if (!exists) this.notFound('MEDIA_NO_LONGER_STORED', 'Изображение больше недоступно.');
    const expiresAt = new Date(Date.now() + this.environment.FILES_DOWNLOAD_TTL_SECONDS * 1000);
    return {
      url: await this.storage.createDownloadUrl({
        objectKey: media.objectKey,
        expiresInSeconds: this.environment.FILES_DOWNLOAD_TTL_SECONDS,
      }),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async validateAndBindPublicMedia(
    transaction: Prisma.TransactionClient,
    input: PublicMediaBindingInput,
  ): Promise<void> {
    const media = await transaction.mediaObject.findFirst({
      where: {
        id: input.mediaId,
        uploaderAccountId: input.accountId,
        contentScope: 'public_content',
        state: { in: ['moderation_pending', 'approved'] },
      },
    });
    if (!media) {
      throw new ApplicationError(
        'MEDIA_NOT_READY',
        'Изображение ещё не готово или не принадлежит этому объекту.',
        409,
        true,
      );
    }
    const upload = await transaction.uploadSession.findFirst({
      where: {
        id: media.uploadSessionId,
        ownerAccountId: input.accountId,
        ownerType: input.ownerType,
        ownerRef: input.ownerId,
      },
      select: { id: true },
    });
    if (!upload) {
      throw new ApplicationError(
        'MEDIA_NOT_READY',
        'Изображение не подходит для этого объекта.',
        409,
      );
    }
    if (media.state === 'approved') return;
    const occupied = await transaction.mediaBinding.findFirst({
      where: { ownerType: input.versionType, ownerId: input.versionId, slot: 0 },
    });
    if (occupied && occupied.mediaId !== input.mediaId) {
      throw new ApplicationError(
        'MEDIA_NOT_READY',
        'Для этой версии уже выбрано изображение.',
        409,
      );
    }
    await transaction.mediaBinding.upsert({
      where: { mediaId: input.mediaId },
      create: {
        mediaId: input.mediaId,
        ownerType: input.versionType,
        ownerId: input.versionId,
        slot: 0,
        boundAt: new Date(),
      },
      update: {
        ownerType: input.versionType,
        ownerId: input.versionId,
        slot: 0,
        boundAt: new Date(),
      },
    });
  }

  async createModerationUrl(mediaId: string): Promise<string | undefined> {
    const media = await this.database.mediaObject.findFirst({
      where: {
        id: mediaId,
        contentScope: 'public_content',
        state: { in: ['moderation_pending', 'approved'] },
      },
    });
    if (!media) {
      throw new ApplicationError('MEDIA_NOT_READY', 'Изображение не готово к проверке.', 409, true);
    }
    if (media.state === 'approved') return undefined;
    return this.storage.createDownloadUrl({
      objectKey: media.objectKey,
      expiresInSeconds: Math.min(300, this.environment.FILES_DOWNLOAD_TTL_SECONDS),
    });
  }

  async applyPublicMediaDecision(
    transaction: Prisma.TransactionClient,
    mediaId: string,
    approved: boolean,
  ): Promise<void> {
    const updated = await transaction.mediaObject.updateMany({
      where: {
        id: mediaId,
        contentScope: 'public_content',
        state: { in: ['moderation_pending', approved ? 'approved' : 'rejected'] },
      },
      data: {
        state: approved ? 'approved' : 'rejected',
        ...(approved ? { attachedAt: new Date() } : {}),
        rowVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ApplicationError('MEDIA_NOT_READY', 'Состояние изображения изменилось.', 409);
    }
  }

  async queueDeletion(mediaId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const media = await transaction.mediaObject.findUnique({ where: { id: mediaId } });
      if (!media) return;
      const tombstone = await transaction.mediaDeletionTombstone.findUnique({
        where: { mediaId },
      });
      await transaction.mediaBinding.deleteMany({ where: { mediaId } });
      if (tombstone?.state === 'completed') {
        await transaction.mediaObject.delete({ where: { id: mediaId } });
        return;
      }
      await transaction.mediaObject.updateMany({
        where: { id: mediaId, state: { not: 'deleted' } },
        data: {
          state: 'deleting',
          deletedAt: new Date(),
          rowVersion: { increment: 1 },
        },
      });
      if (tombstone) return;
      await transaction.$executeRaw`
        INSERT INTO files.media_deletion_tombstones
          (media_id, bucket, object_key, state, available_at)
        VALUES
          (${mediaId}::uuid, ${media.bucket}, ${media.objectKey}, 'pending', now())
        ON CONFLICT (media_id) DO NOTHING
      `;
    });
  }

  private async assertOwner(
    accountId: string,
    ownerType: UploadCreateInput['ownerType'],
    ownerId: string,
  ): Promise<void> {
    if (
      (ownerType === 'profile' || ownerType === 'resume') &&
      !(await this.profiles.ownsMediaOwner(accountId, ownerType, ownerId))
    ) {
      this.notFound('OWNER_NOT_FOUND', 'Объект-владелец не найден.');
    }
    // Team, opportunity, event and message draft IDs are opaque delegated references
    // until their bounded contexts publish owner contracts. Access remains account-scoped.
  }

  private async toView(session: {
    id: string;
    contentScope: ContentScope;
    state: string;
    expiresAt: Date;
    failureCode: string | null;
  }): Promise<UploadSessionView> {
    const media = await this.database.mediaObject.findUnique({
      where: { uploadSessionId: session.id },
      select: { id: true, state: true },
    });
    return {
      id: session.id,
      contentScope: session.contentScope,
      state: publicStateFor(session.contentScope, media?.state ?? session.state),
      ...(media ? { mediaId: media.id } : {}),
      expiresAt: session.expiresAt.toISOString(),
      ...(session.failureCode ? { failureCode: session.failureCode } : {}),
    };
  }

  private validateIdempotencyKey(value: string): void {
    if (!idempotencyKeySchema.safeParse(value).success) {
      throw new ApplicationError('INVALID_REQUEST', 'Укажите корректный Idempotency-Key.', 422);
    }
  }

  private async lookupIdempotency(
    accountId: string,
    route: string,
    key: string,
    requestHash: Buffer,
  ): Promise<IdempotencyReplay | undefined> {
    const record = await this.database.idempotencyRecord.findFirst({
      where: { actorAccountId: accountId, route, key, expiresAt: { gt: new Date() } },
    });
    return record ? this.evaluateIdempotency(record, requestHash) : undefined;
  }

  private async reserveIdempotency(
    transaction: Prisma.TransactionClient,
    accountId: string,
    route: string,
    key: string,
    requestHash: Buffer,
  ): Promise<IdempotencyReplay | undefined> {
    const id = uuidv7();
    await transaction.$executeRaw`
      DELETE FROM platform.idempotency_records
      WHERE actor_account_id = ${accountId}::uuid
        AND route = ${route}
        AND key = ${key}
        AND expires_at <= now()
    `;
    const inserted = await transaction.$executeRaw`
      INSERT INTO platform.idempotency_records
        (id, actor_account_id, route, key, request_hash, state, expires_at)
      VALUES
        (${id}::uuid, ${accountId}::uuid, ${route}, ${key}, ${requestHash}, 'in_progress', ${new Date(Date.now() + IDEMPOTENCY_TTL_MS)})
      ON CONFLICT (actor_account_id, route, key) WHERE actor_account_id IS NOT NULL DO NOTHING
    `;
    if (inserted === 1) return undefined;
    const existing = await transaction.idempotencyRecord.findFirst({
      where: { actorAccountId: accountId, route, key, expiresAt: { gt: new Date() } },
    });
    if (!existing)
      throw new ApplicationError(
        'IDEMPOTENCY_IN_PROGRESS',
        'Повторите запрос позже.',
        409,
        true,
        undefined,
        undefined,
        1,
      );
    return this.evaluateIdempotency(existing, requestHash);
  }

  private evaluateIdempotency(
    record: Pick<
      Prisma.IdempotencyRecordGetPayload<object>,
      'requestHash' | 'state' | 'responseStatus' | 'responseBody' | 'responseSecret'
    >,
    requestHash: Buffer,
  ): IdempotencyReplay {
    if (!isSameBytes(record.requestHash, requestHash)) {
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REUSED',
        'Этот ключ повтора уже использован с другими данными.',
        409,
      );
    }
    if (
      record.state !== 'completed' ||
      record.responseStatus === null ||
      record.responseBody === null
    ) {
      throw new ApplicationError(
        'IDEMPOTENCY_IN_PROGRESS',
        'Предыдущий запрос ещё выполняется. Повторите позже.',
        409,
        true,
        undefined,
        undefined,
        1,
      );
    }
    const body = record.responseBody as Record<string, unknown>;
    if (!record.responseSecret) return { body, status: record.responseStatus };
    return {
      body: {
        ...body,
        uploadUrl: decryptSecret(this.environment.AUTH_TOKEN_ENCRYPTION_KEY, record.responseSecret),
      },
      status: record.responseStatus,
    };
  }

  private async completeIdempotency(
    transaction: Prisma.TransactionClient,
    accountId: string,
    route: string,
    key: string,
    status: number,
    body: unknown,
    responseRefId: string,
  ): Promise<void> {
    const response = body as Record<string, unknown>;
    const uploadUrl = typeof response.uploadUrl === 'string' ? response.uploadUrl : undefined;
    const { uploadUrl: _secretUrl, ...safeBody } = response;
    await transaction.idempotencyRecord.updateMany({
      where: { actorAccountId: accountId, route, key, state: 'in_progress' },
      data: {
        state: 'completed',
        responseStatus: status,
        responseRefType: 'files',
        responseRefId,
        responseBody: (uploadUrl ? safeBody : response) as Prisma.InputJsonValue,
        responseSecret: uploadUrl
          ? new Uint8Array(encryptSecret(this.environment.AUTH_TOKEN_ENCRYPTION_KEY, uploadUrl))
          : undefined,
      },
    });
  }

  private notFound(
    code: 'UPLOAD_NOT_FOUND' | 'OWNER_NOT_FOUND' | 'MEDIA_NO_LONGER_STORED',
    message: string,
  ): never {
    throw new ApplicationError(code, message, 404);
  }
}
