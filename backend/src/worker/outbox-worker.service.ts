import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import Redis, { type RedisOptions } from 'ioredis';
import { z } from 'zod';
import { metrics } from '@opentelemetry/api';
import { LegalEvidenceStore } from '../modules/compliance';
import { EMAIL_SENDER, type EmailSender } from '../modules/identity';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import { decryptSecret } from '../platform/security/crypto';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WORKER_ENVIRONMENT, WORKER_LOGGER } from './worker.tokens';
import { purgeMainRegistrationState } from './registration-retention';

const QUEUE_NAME = 'platform-outbox';
const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const outboxMeter = metrics.getMeter('komanda-mpei-outbox');
const deliveryCounter = outboxMeter.createCounter('outbox.delivery.attempts');
const deliveryDuration = outboxMeter.createHistogram('outbox.delivery.duration', {
  unit: 'ms',
});
const oldestPendingAge = outboxMeter.createHistogram('outbox.oldest_pending.age', { unit: 'ms' });

const emailPayloadSchema = z.object({ encryptedToken: z.string().base64() }).strict();
interface ClaimedDelivery {
  id: string;
  eventId: string;
  consumer: string;
  leaseVersion: string;
}

interface DeliveryJob {
  deliveryId: string;
  leaseVersion: string;
}

function queueRedisOptions(environment: WorkerEnvironment): RedisOptions {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: environment.DEPENDENCY_TIMEOUT_MS,
  };
}

function workerRedisOptions(): RedisOptions {
  return { maxRetriesPerRequest: null, enableReadyCheck: true };
}

@Injectable()
export class OutboxWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #database: PrismaClient;
  #queueRedis?: Redis;
  readonly #workerRedis: Redis;
  #queue?: Queue;
  #worker?: Worker;
  #pollTimer?: NodeJS.Timeout;
  #polling?: Promise<void>;
  #shuttingDown = false;
  #lastCleanupAt = 0;

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(WORKER_LOGGER) private readonly logger: JsonLogger,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    @Inject(LegalEvidenceStore) private readonly legalEvidence: LegalEvidenceStore,
  ) {
    this.#database = new PrismaClient({
      datasources: { db: { url: environment.WORKER_DATABASE_URL } },
    });
    this.#workerRedis = new Redis(environment.REDIS_URL, workerRedisOptions());
    this.#workerRedis.on('error', () => undefined);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.#replaceQueue();
    this.#worker = new Worker(QUEUE_NAME, async (job: Job<DeliveryJob>) => this.#handle(job.data), {
      connection: this.#workerRedis,
      concurrency: 5,
    });
    this.#worker.on('error', () => undefined);
    await this.#dispatch();
    this.#schedule();
  }

  #schedule(): void {
    if (this.#shuttingDown) return;
    this.#pollTimer = setTimeout(() => {
      this.#polling = this.#dispatch()
        .catch(() => undefined)
        .finally(() => {
          this.#polling = undefined;
          this.#schedule();
        });
    }, this.environment.OUTBOX_POLL_INTERVAL_MS);
  }

  async #dispatch(): Promise<void> {
    if (!this.#queue) return;
    await this.#recordOldestPendingAge();
    await this.#cleanupIfDue();
    const claimed = await this.#database.$queryRaw<ClaimedDelivery[]>`
      WITH candidates AS (
        SELECT id
        FROM platform.outbox_deliveries
        WHERE (state = 'pending' AND available_at <= now())
           OR (state = 'leased' AND lease_until < now())
        ORDER BY available_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 20
      )
      UPDATE platform.outbox_deliveries AS delivery
      SET state = 'leased',
          lease_until = now() + interval '30 seconds',
          updated_at = now(),
          row_version = row_version + 1
      FROM candidates
      WHERE delivery.id = candidates.id
      RETURNING delivery.id,
                delivery.event_id AS "eventId",
                delivery.consumer,
                delivery.row_version::text AS "leaseVersion"
    `;
    for (const delivery of claimed) {
      try {
        await this.#queue.add(
          'deliver',
          { deliveryId: delivery.id, leaseVersion: delivery.leaseVersion },
          {
            jobId: `${delivery.eventId}--${delivery.consumer}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } catch {
        await this.#database.outboxDelivery.updateMany({
          where: {
            id: delivery.id,
            state: 'leased',
            rowVersion: BigInt(delivery.leaseVersion),
          },
          data: {
            state: 'pending',
            leaseUntil: null,
            availableAt: new Date(Date.now() + 1000),
            lastErrorCode: 'QUEUE_UNAVAILABLE',
            rowVersion: { increment: 1 },
          },
        });
        this.#replaceQueue();
      }
    }
  }

  #replaceQueue(): void {
    void this.#queue?.disconnect().catch(() => undefined);
    this.#queueRedis?.disconnect(false);
    this.#queueRedis = new Redis(this.environment.REDIS_URL, queueRedisOptions(this.environment));
    this.#queueRedis.on('error', () => undefined);
    this.#queue = new Queue(QUEUE_NAME, { connection: this.#queueRedis });
    this.#queue.on('error', () => undefined);
  }

  async #handle(job: DeliveryJob): Promise<void> {
    const startedAt = performance.now();
    const leaseVersion = BigInt(job.leaseVersion);
    const processingVersion = leaseVersion + 1n;
    const started = await this.#database.outboxDelivery.updateMany({
      where: {
        id: job.deliveryId,
        state: 'leased',
        rowVersion: leaseVersion,
        leaseUntil: { gt: new Date() },
      },
      data: { attemptCount: { increment: 1 }, rowVersion: { increment: 1 } },
    });
    if (started.count !== 1) return;
    const delivery = await this.#database.outboxDelivery.findUnique({
      where: { id: job.deliveryId },
      include: { event: true },
    });
    if (!delivery || delivery.state !== 'leased') return;
    let leaseLost = false;
    let renewalInFlight = Promise.resolve();
    const renewalTimer = setInterval(
      () => {
        renewalInFlight = this.#database.outboxDelivery
          .updateMany({
            where: { id: delivery.id, state: 'leased', rowVersion: processingVersion },
            data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
          })
          .then(({ count }) => {
            if (count !== 1) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          });
      },
      Math.floor(LEASE_MS / 3),
    );
    try {
      if (delivery.event.eventVersion !== 1) throw new Error('EVENT_VERSION_UNSUPPORTED');
      if (delivery.consumer === 'identity.verification-email') {
        await this.#sendVerificationEmail(delivery.event);
      } else if (delivery.consumer === 'compliance.consent-evidence') {
        await this.legalEvidence.appendConsentEvidence(delivery.event);
      } else {
        throw new Error('CONSUMER_UNKNOWN');
      }
      clearInterval(renewalTimer);
      await renewalInFlight;
      if (leaseLost) throw new Error('DELIVERY_LEASE_LOST');
      const completed = await this.#database.outboxDelivery.updateMany({
        where: { id: delivery.id, state: 'leased', rowVersion: processingVersion },
        data: {
          state: 'completed',
          completedAt: new Date(),
          leaseUntil: null,
          lastErrorCode: null,
          rowVersion: { increment: 1 },
        },
      });
      if (completed.count !== 1) throw new Error('DELIVERY_LEASE_LOST');
      this.logger
        .child({
          eventId: delivery.eventId,
          correlationId: delivery.event.correlationId,
          module: 'platform',
          operation: 'outbox.deliver',
          consumer: delivery.consumer,
          result: 'completed',
          attempt: delivery.attemptCount,
          latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        })
        .info('Outbox delivery завершена.');
      deliveryCounter.add(1, { consumer: delivery.consumer, result: 'completed' });
      deliveryDuration.record(performance.now() - startedAt, { consumer: delivery.consumer });
    } catch (error) {
      clearInterval(renewalTimer);
      await renewalInFlight;
      const errorCode = error instanceof Error ? error.message.slice(0, 100) : 'DELIVERY_FAILED';
      const deadLetter = delivery.attemptCount >= MAX_ATTEMPTS;
      await this.#database.outboxDelivery.updateMany({
        where: { id: delivery.id, state: 'leased', rowVersion: processingVersion },
        data: {
          state: deadLetter ? 'dead_letter' : 'pending',
          leaseUntil: null,
          availableAt: new Date(Date.now() + Math.min(60_000, 2 ** delivery.attemptCount * 1000)),
          lastErrorCode: errorCode,
          rowVersion: { increment: 1 },
        },
      });
      this.logger.warn('Outbox delivery будет повторена.', 'OutboxWorker');
      deliveryCounter.add(1, {
        consumer: delivery.consumer,
        result: deadLetter ? 'dead_letter' : 'retry',
      });
    }
  }

  async #sendVerificationEmail(event: {
    id: string;
    aggregateId: string;
    payload: unknown;
  }): Promise<void> {
    const payload = emailPayloadSchema.parse(event.payload);
    const account = await this.#database.account.findUnique({
      where: { id: event.aggregateId },
      select: { emailNormalized: true },
    });
    if (!account) throw new Error('ACCOUNT_NOT_FOUND');
    const token = decryptSecret(
      this.environment.AUTH_TOKEN_ENCRYPTION_KEY,
      Buffer.from(payload.encryptedToken, 'base64'),
    );
    const verificationUrl = new URL('/verify-email', this.environment.PUBLIC_APP_URL);
    verificationUrl.searchParams.set('token', token);
    await this.emailSender.sendVerificationEmail({
      eventId: event.id,
      recipient: account.emailNormalized,
      verificationUrl: verificationUrl.toString(),
    });
  }

  async #recordOldestPendingAge(): Promise<void> {
    const rows = await this.#database.$queryRaw<Array<{ ageMs: number | bigint | null }>>`
      SELECT EXTRACT(EPOCH FROM (now() - MIN(event.occurred_at))) * 1000 AS "ageMs"
      FROM platform.outbox_deliveries AS delivery
      JOIN platform.outbox_events AS event ON event.id = delivery.event_id
      WHERE delivery.state IN ('pending', 'leased')
    `;
    const age = rows[0]?.ageMs;
    if (age !== null && age !== undefined) oldestPendingAge.record(Number(age));
  }

  async #cleanupIfDue(now = new Date()): Promise<void> {
    if (now.getTime() - this.#lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    this.#lastCleanupAt = now.getTime();
    try {
      await purgeMainRegistrationState(this.#database, now);
    } catch {
      this.logger.warn('Очистка terminal registration state будет повторена.', 'OutboxWorker');
    }
    try {
      await this.legalEvidence.purgeExpired(now);
    } catch {
      this.logger.warn('Очистка legal evidence будет повторена.', 'OutboxWorker');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    await this.#polling;
    await this.#worker?.close(true).catch(() => undefined);
    await this.#queue?.disconnect().catch(() => undefined);
    this.#queueRedis?.disconnect(false);
    this.#workerRedis.disconnect(false);
    this.emailSender.close();
    await this.#database.$disconnect();
  }
}

export { CLEANUP_INTERVAL_MS, LEASE_MS, MAX_ATTEMPTS, queueRedisOptions, workerRedisOptions };
