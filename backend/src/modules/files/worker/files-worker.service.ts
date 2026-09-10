import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { metrics } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { WorkerEnvironment } from '../../../platform/config/env.schema';
import { ApplicationError } from '../../../platform/http/application-error';
import type { JsonLogger } from '../../../platform/observability/json-logger';
import { WORKER_LOGGER } from '../../../worker/worker.tokens';
import type { MalwareScanner } from '../application/malware-scanner.port';
import type { ObjectStorage, StoredObjectMetadata } from '../application/object-storage.port';
import { retentionClassFor } from '../domain/image-rules';
import { FILES_ENVIRONMENT, MALWARE_SCANNER, OBJECT_STORAGE } from '../files.tokens';
import type { UploadOwnerType } from '../files.types';
import { sanitizeImage } from '../infrastructure/image-sanitizer';

const TERMINAL_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETED_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const mediaMeter = metrics.getMeter('komanda-mpei-files');
const processingCounter = mediaMeter.createCounter('files.processing.results');
const processingDuration = mediaMeter.createHistogram('files.processing.duration', { unit: 'ms' });
const cleanupCounter = mediaMeter.createCounter('files.cleanup.results');
const queueBacklog = mediaMeter.createGauge('files.queue.backlog');
const queueOldestAge = mediaMeter.createGauge('files.queue.oldest_age', { unit: 's' });

interface ClaimedUpload {
  id: string;
  row_version: bigint;
}

interface ClaimedTombstone {
  media_id: string;
  object_key: string;
  row_version: bigint;
}

export function assertStoredUploadMatches(
  before: StoredObjectMetadata | undefined,
  after: StoredObjectMetadata | undefined,
  bodyLength: number,
  expectedSizeBytes: number,
  expectedMime: string,
  expectedETag: string | null,
): void {
  if (
    !before ||
    !after ||
    !expectedETag ||
    before.eTag !== expectedETag ||
    after.eTag !== expectedETag ||
    before.contentLength !== expectedSizeBytes ||
    after.contentLength !== expectedSizeBytes ||
    before.contentType !== expectedMime ||
    after.contentType !== expectedMime ||
    bodyLength !== expectedSizeBytes
  ) {
    throw new ApplicationError(
      'UPLOAD_OBJECT_MISMATCH',
      'Переданный файл не соответствует заявленным параметрам.',
      409,
    );
  }
}

@Injectable()
export class FilesWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #database: PrismaClient;
  #timer?: NodeJS.Timeout;
  #running?: Promise<void>;
  #stopping = false;

  constructor(
    @Inject(FILES_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(WORKER_LOGGER) private readonly logger: JsonLogger,
  ) {
    this.#database = new PrismaClient({
      datasources: { db: { url: environment.WORKER_DATABASE_URL } },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.#runOnce();
    this.#schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
    await this.#database.$disconnect();
  }

  async processPending(): Promise<void> {
    await this.#runOnce();
  }

  async #runOnce(): Promise<void> {
    if (this.#stopping) return;
    const startedAt = performance.now();
    this.#running = (async () => {
      const sessions = await this.#claimUploads();
      for (const session of sessions) await this.#processSession(session.id, session.row_version);
      await this.#expireUploads();
      await this.#cleanupQuarantine();
      await this.#processTombstones();
      await this.#purgeMetadata();
      await this.#recordQueueAge();
    })();
    try {
      await this.#running;
    } finally {
      this.#running = undefined;
      this.logger
        .child({
          module: 'files',
          operation: 'worker.poll',
          result: 'completed',
          latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        })
        .debug('Files worker poll завершён.');
    }
  }

  #schedule(): void {
    if (this.#stopping) return;
    this.#timer = setTimeout(() => {
      void this.#runOnce()
        .catch((error: unknown) => {
          this.logger.warn(
            error instanceof Error ? error.message : 'Files worker poll failed.',
            'FilesWorker',
          );
        })
        .finally(() => this.#schedule());
    }, this.environment.FILES_WORKER_INTERVAL_MS);
  }

  async #claimUploads(): Promise<ClaimedUpload[]> {
    return this.#database.$queryRaw<ClaimedUpload[]>`
      WITH candidates AS (
        SELECT id
        FROM files.upload_sessions
        WHERE state = 'processing'
          AND (processing_lease_until IS NULL OR processing_lease_until <= now())
        ORDER BY created_at, id
        LIMIT 5
        FOR UPDATE SKIP LOCKED
      )
      UPDATE files.upload_sessions AS session
      SET processing_lease_until = now() + interval '30 seconds',
          processing_attempt_count = processing_attempt_count + 1,
          row_version = row_version + 1,
          updated_at = now()
      FROM candidates
      WHERE session.id = candidates.id
      RETURNING session.id, session.row_version
    `;
  }

  async #processSession(uploadSessionId: string, claimedVersion: bigint): Promise<void> {
    const startedAt = performance.now();
    const session = await this.#database.uploadSession.findUnique({
      where: { id: uploadSessionId },
    });
    if (
      !session ||
      session.state !== 'processing' ||
      session.rowVersion !== claimedVersion ||
      !session.processingLeaseUntil ||
      session.processingLeaseUntil <= new Date()
    ) {
      return;
    }
    const log = this.logger.child({
      module: 'files',
      operation: 'upload.process',
      correlationId: session.correlationId,
      eventId: session.eventId,
    });
    let sanitizedKey: string | undefined;
    let sanitizedMediaId: string | undefined;
    try {
      const metadataBefore = await this.storage.head(session.objectKey);
      const source = await this.storage.get(session.objectKey);
      const metadataAfter = await this.storage.head(session.objectKey);
      assertStoredUploadMatches(
        metadataBefore,
        metadataAfter,
        source.length,
        session.expectedSizeBytes,
        session.expectedMime,
        session.sourceEtag,
      );
      const sanitized = await sanitizeImage(
        source,
        session.expectedMime,
        this.scanner,
        this.environment.FILES_MAX_OUTPUT_BYTES,
      );
      const mediaId = uuidv7();
      sanitizedMediaId = mediaId;
      sanitizedKey = `media/${uploadSessionId}/${mediaId}.jpg`;
      await this.storage.put(sanitizedKey, sanitized.body, sanitized.mime);
      const mediaState =
        session.contentScope === 'private_message' ? 'technically_ready' : 'moderation_pending';
      let committed = false;
      await this.#database.$transaction(async (transaction) => {
        const transitioned = await transaction.uploadSession.updateMany({
          where: {
            id: uploadSessionId,
            state: 'processing',
            rowVersion: claimedVersion,
            processingLeaseUntil: { gt: new Date() },
          },
          data: {
            state: 'technically_ready',
            failureCode: null,
            processingLeaseUntil: null,
            rowVersion: { increment: 1 },
          },
        });
        if (transitioned.count !== 1) return;
        await transaction.mediaObject.create({
          data: {
            id: mediaId,
            uploadSessionId,
            uploaderAccountId: session.ownerAccountId,
            contentScope: session.contentScope,
            state: mediaState,
            bucket: this.environment.S3_BUCKET,
            objectKey: sanitizedKey!,
            sha256: createHash('sha256').update(sanitized.body).digest(),
            mime: sanitized.mime,
            sizeBytes: sanitized.sizeBytes,
            width: sanitized.width,
            height: sanitized.height,
            retentionClass: retentionClassFor(session.ownerType as UploadOwnerType),
          },
        });
        committed = true;
      });
      if (!committed) {
        await this.#deleteSanitizedOrQueue(mediaId, sanitizedKey);
        return;
      }
      await this.#deleteQuarantine(session.id, session.objectKey);
      processingCounter.add(1, { result: 'ready', scope: session.contentScope });
      processingDuration.record(performance.now() - startedAt, { scope: session.contentScope });
      log.info({ result: 'ready' }, 'Media processing completed.');
    } catch (error) {
      if (sanitizedKey && sanitizedMediaId) {
        await this.#deleteSanitizedOrQueue(sanitizedMediaId, sanitizedKey);
      }
      if (!(error instanceof ApplicationError)) {
        await this.#releaseUploadClaim(uploadSessionId, claimedVersion);
        processingCounter.add(1, { result: 'retry', scope: session.contentScope });
        processingDuration.record(performance.now() - startedAt, { scope: session.contentScope });
        log.warn({ result: 'retry' }, 'Media processing temporarily unavailable.');
        return;
      }
      const failed = await this.#database.uploadSession.updateMany({
        where: { id: uploadSessionId, state: 'processing', rowVersion: claimedVersion },
        data: {
          state: 'failed',
          failureCode: error.code,
          processingLeaseUntil: null,
          rowVersion: { increment: 1 },
        },
      });
      if (failed.count === 1) await this.#deleteQuarantine(session.id, session.objectKey);
      processingCounter.add(1, { result: 'failed', scope: session.contentScope });
      processingDuration.record(performance.now() - startedAt, { scope: session.contentScope });
      log.warn({ result: 'failed', failureCode: error.code }, 'Media processing failed.');
    }
  }

  async #releaseUploadClaim(uploadSessionId: string, claimedVersion: bigint): Promise<void> {
    await this.#database.uploadSession.updateMany({
      where: { id: uploadSessionId, state: 'processing', rowVersion: claimedVersion },
      data: { processingLeaseUntil: null, rowVersion: { increment: 1 } },
    });
  }

  async #deleteSanitizedOrQueue(mediaId: string, objectKey: string): Promise<void> {
    try {
      await this.storage.delete(objectKey);
    } catch {
      await this.#database.mediaDeletionTombstone.upsert({
        where: { mediaId },
        create: {
          mediaId,
          bucket: this.environment.S3_BUCKET,
          objectKey,
          availableAt: new Date(),
          lastErrorCode: 'STORAGE_DELETE_FAILED',
        },
        update: {
          state: 'pending',
          availableAt: new Date(),
          leaseUntil: null,
          completedAt: null,
          lastErrorCode: 'STORAGE_DELETE_FAILED',
          rowVersion: { increment: 1 },
        },
      });
    }
  }

  async #deleteQuarantine(uploadSessionId: string, objectKey: string): Promise<void> {
    try {
      await this.storage.delete(objectKey);
      await this.#database.uploadSession.updateMany({
        where: { id: uploadSessionId, quarantineDeletedAt: null },
        data: { quarantineDeletedAt: new Date(), rowVersion: { increment: 1 } },
      });
      cleanupCounter.add(1, { result: 'deleted', queue: 'quarantine' });
    } catch {
      cleanupCounter.add(1, { result: 'retry', queue: 'quarantine' });
      this.logger.warn('Quarantine object deletion failed; cleanup will retry.', 'FilesWorker');
    }
  }

  async #expireUploads(): Promise<void> {
    const now = new Date();
    await this.#database.uploadSession.updateMany({
      where: { state: { in: ['created', 'uploaded'] }, expiresAt: { lte: now } },
      data: {
        state: 'expired',
        failureCode: 'UPLOAD_EXPIRED',
        rowVersion: { increment: 1 },
      },
    });
    await this.#database.uploadSession.updateMany({
      where: {
        state: 'processing',
        expiresAt: {
          lte: new Date(now.getTime() - this.environment.FILES_QUARANTINE_TTL_SECONDS * 1000),
        },
        OR: [{ processingLeaseUntil: null }, { processingLeaseUntil: { lte: now } }],
      },
      data: {
        state: 'failed',
        failureCode: 'UPLOAD_EXPIRED',
        processingLeaseUntil: null,
        rowVersion: { increment: 1 },
      },
    });
  }

  async #cleanupQuarantine(): Promise<void> {
    const sessions = await this.#database.uploadSession.findMany({
      where: {
        quarantineDeletedAt: null,
        state: { in: ['technically_ready', 'failed', 'expired', 'consumed'] },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, objectKey: true },
      take: 50,
    });
    for (const session of sessions) await this.#deleteQuarantine(session.id, session.objectKey);
  }

  async #processTombstones(): Promise<void> {
    const claimed = await this.#database.$queryRaw<ClaimedTombstone[]>`
      WITH candidate AS (
        SELECT media_id
        FROM files.media_deletion_tombstones
        WHERE (
          (state IN ('pending', 'failed') AND available_at <= now()) OR
          (state = 'in_progress' AND lease_until <= now())
        )
        ORDER BY available_at, media_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE files.media_deletion_tombstones AS tombstone
      SET state = 'in_progress',
          attempt_count = attempt_count + 1,
          lease_until = now() + interval '30 seconds',
          completed_at = NULL,
          last_error_code = NULL,
          row_version = row_version + 1,
          updated_at = now()
      FROM candidate
      WHERE tombstone.media_id = candidate.media_id
      RETURNING tombstone.media_id, tombstone.object_key, tombstone.row_version
    `;
    const tombstone = claimed[0];
    if (!tombstone) return;
    try {
      await this.storage.delete(tombstone.object_key);
      await this.#database.$transaction(async (transaction) => {
        const completed = await transaction.mediaDeletionTombstone.updateMany({
          where: {
            mediaId: tombstone.media_id,
            state: 'in_progress',
            rowVersion: tombstone.row_version,
          },
          data: {
            state: 'completed',
            completedAt: new Date(),
            leaseUntil: null,
            rowVersion: { increment: 1 },
          },
        });
        if (completed.count !== 1) return;
        await transaction.mediaBinding.deleteMany({ where: { mediaId: tombstone.media_id } });
        await transaction.mediaObject.deleteMany({ where: { id: tombstone.media_id } });
      });
      cleanupCounter.add(1, { result: 'deleted', queue: 'tombstone' });
    } catch {
      await this.#database.mediaDeletionTombstone.updateMany({
        where: {
          mediaId: tombstone.media_id,
          state: 'in_progress',
          rowVersion: tombstone.row_version,
        },
        data: {
          state: 'failed',
          leaseUntil: null,
          availableAt: new Date(Date.now() + 5000),
          lastErrorCode: 'STORAGE_DELETE_FAILED',
          rowVersion: { increment: 1 },
        },
      });
      cleanupCounter.add(1, { result: 'retry', queue: 'tombstone' });
    }
  }

  async #purgeMetadata(): Promise<void> {
    await this.#database.uploadSession.deleteMany({
      where: {
        state: { in: ['technically_ready', 'failed', 'expired', 'consumed'] },
        quarantineDeletedAt: { not: null },
        updatedAt: { lte: new Date(Date.now() - TERMINAL_UPLOAD_RETENTION_MS) },
      },
    });
    await this.#database.mediaDeletionTombstone.deleteMany({
      where: {
        state: 'completed',
        completedAt: { lte: new Date(Date.now() - COMPLETED_TOMBSTONE_RETENTION_MS) },
      },
    });
  }

  async #recordQueueAge(): Promise<void> {
    const [upload, uploadCount, tombstone, tombstoneCount, quarantine, quarantineCount] =
      await Promise.all([
        this.#database.uploadSession.findFirst({
          where: { state: 'processing' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.#database.uploadSession.count({ where: { state: 'processing' } }),
        this.#database.mediaDeletionTombstone.findFirst({
          where: { state: { in: ['pending', 'failed', 'in_progress'] } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.#database.mediaDeletionTombstone.count({
          where: { state: { in: ['pending', 'failed', 'in_progress'] } },
        }),
        this.#database.uploadSession.findFirst({
          where: {
            quarantineDeletedAt: null,
            state: { in: ['technically_ready', 'failed', 'expired', 'consumed'] },
          },
          orderBy: { updatedAt: 'asc' },
          select: { updatedAt: true },
        }),
        this.#database.uploadSession.count({
          where: {
            quarantineDeletedAt: null,
            state: { in: ['technically_ready', 'failed', 'expired', 'consumed'] },
          },
        }),
      ]);
    const now = Date.now();
    queueBacklog.record(uploadCount, { queue: 'processing' });
    queueBacklog.record(tombstoneCount, { queue: 'tombstone' });
    queueBacklog.record(quarantineCount, { queue: 'quarantine' });
    queueOldestAge.record(upload ? (now - upload.createdAt.getTime()) / 1000 : 0, {
      queue: 'processing',
    });
    queueOldestAge.record(tombstone ? (now - tombstone.createdAt.getTime()) / 1000 : 0, {
      queue: 'tombstone',
    });
    queueOldestAge.record(quarantine ? (now - quarantine.updatedAt.getTime()) / 1000 : 0, {
      queue: 'quarantine',
    });
  }
}
