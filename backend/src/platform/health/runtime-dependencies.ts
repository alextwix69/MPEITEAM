import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import type { RuntimeEnvironment } from '../config/env.schema';
import type { ComponentStatus, DependencyProbe } from './health.types';

const FOUNDATION_MIGRATION = '20260901000100_platform_foundation';

export async function checkFoundationMigration(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  timeoutMs: number,
): Promise<boolean> {
  const migrations = await within(
    prisma.$queryRaw<Array<{ applied: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE migration_name = ${FOUNDATION_MIGRATION}
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      ) AS applied
    `,
    timeoutMs,
  );
  return migrations[0]?.applied === true;
}

export function probeDatabaseUrl(environment: RuntimeEnvironment): string {
  const configuredUrl =
    'API_DATABASE_URL' in environment
      ? environment.API_DATABASE_URL
      : environment.WORKER_DATABASE_URL;
  const url = new URL(configuredUrl);
  const timeoutSeconds = Math.max(1, Math.ceil(environment.DEPENDENCY_TIMEOUT_MS / 1000));
  url.searchParams.set('connect_timeout', String(timeoutSeconds));
  url.searchParams.set('pool_timeout', String(timeoutSeconds));
  url.searchParams.set('socket_timeout', String(timeoutSeconds));
  url.searchParams.set('statement_timeout', String(environment.DEPENDENCY_TIMEOUT_MS));
  return url.toString();
}

export async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new Error('DEPENDENCY_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class SingleFlight {
  readonly #operations = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#operations.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = Promise.resolve().then(operation);
    const tracked = pending.finally(() => {
      if (this.#operations.get(key) === tracked) this.#operations.delete(key);
    });
    this.#operations.set(key, tracked);
    return tracked;
  }

  async wait(): Promise<void> {
    await Promise.allSettled([...this.#operations.values()]);
  }
}

export class RuntimeDependencies implements DependencyProbe {
  readonly #prisma: PrismaClient;
  readonly #redis: Redis;
  readonly #s3: S3Client;
  readonly #singleFlight = new SingleFlight();
  readonly #s3AbortControllers = new Set<AbortController>();
  #redisConnection?: Promise<void>;
  #closing = false;

  constructor(private readonly environment: RuntimeEnvironment) {
    this.#prisma = new PrismaClient({
      datasources: { db: { url: probeDatabaseUrl(environment) } },
    });
    this.#redis = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2000),
      connectTimeout: environment.DEPENDENCY_TIMEOUT_MS,
      commandTimeout: environment.DEPENDENCY_TIMEOUT_MS,
    });
    this.#redis.on('error', () => undefined);
    this.#s3 = new S3Client({
      endpoint: environment.S3_ENDPOINT,
      region: environment.S3_REGION,
      forcePathStyle: environment.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: environment.S3_ACCESS_KEY,
        secretAccessKey: environment.S3_SECRET_KEY,
      },
    });
  }

  async #ensureRedisConnection(): Promise<void> {
    if (this.#redis.status === 'ready') return;
    if (this.#redisConnection) return this.#redisConnection;
    if (this.#redis.status !== 'wait') throw new Error('REDIS_NOT_READY');

    const connection = this.#redis.connect();
    this.#redisConnection = connection;
    try {
      await connection;
    } finally {
      if (this.#redisConnection === connection) this.#redisConnection = undefined;
    }
  }

  async checkPostgres(): Promise<ComponentStatus> {
    if (this.#closing) return 'down';
    return this.#singleFlight.run('postgres', async () => {
      try {
        return (await checkFoundationMigration(
          this.#prisma,
          this.environment.DEPENDENCY_TIMEOUT_MS,
        )) && !this.#closing
          ? 'up'
          : 'down';
      } catch {
        return 'down';
      }
    });
  }

  async checkRedis(): Promise<ComponentStatus> {
    if (this.#closing) return 'down';
    return this.#singleFlight.run('redis', async () => {
      try {
        await within(this.#ensureRedisConnection(), this.environment.DEPENDENCY_TIMEOUT_MS);
        await within(this.#redis.ping(), this.environment.DEPENDENCY_TIMEOUT_MS);
        return this.#closing ? 'down' : 'up';
      } catch {
        return 'down';
      }
    });
  }

  async checkObjectStorage(): Promise<ComponentStatus> {
    if (this.#closing) return 'down';
    return this.#singleFlight.run('objectStorage', async () => {
      const abortController = new AbortController();
      this.#s3AbortControllers.add(abortController);
      try {
        await within(
          this.#s3.send(new HeadBucketCommand({ Bucket: this.environment.S3_BUCKET }), {
            abortSignal: abortController.signal,
          }),
          this.environment.DEPENDENCY_TIMEOUT_MS,
          () => abortController.abort(),
        );
        return this.#closing ? 'down' : 'up';
      } catch {
        return 'down';
      } finally {
        this.#s3AbortControllers.delete(abortController);
      }
    });
  }

  async checkWorkerHeartbeat(): Promise<ComponentStatus> {
    if (this.#closing) return 'down';
    return this.#singleFlight.run('workerHeartbeat', async () => {
      try {
        await within(this.#ensureRedisConnection(), this.environment.DEPENDENCY_TIMEOUT_MS);
        const heartbeat = await within(
          this.#redis.get(this.environment.WORKER_HEARTBEAT_KEY),
          this.environment.DEPENDENCY_TIMEOUT_MS,
        );
        return heartbeat && !this.#closing ? 'up' : 'down';
      } catch {
        return 'down';
      }
    });
  }

  async writeWorkerHeartbeat(): Promise<void> {
    await within(this.#ensureRedisConnection(), this.environment.DEPENDENCY_TIMEOUT_MS);
    await within(
      this.#redis.set(
        this.environment.WORKER_HEARTBEAT_KEY,
        new Date().toISOString(),
        'EX',
        this.environment.WORKER_HEARTBEAT_TTL_SECONDS,
      ),
      this.environment.DEPENDENCY_TIMEOUT_MS,
    );
  }

  async deleteWorkerHeartbeat(): Promise<void> {
    try {
      await within(this.#ensureRedisConnection(), this.environment.DEPENDENCY_TIMEOUT_MS);
      await within(
        this.#redis.del(this.environment.WORKER_HEARTBEAT_KEY),
        this.environment.DEPENDENCY_TIMEOUT_MS,
      );
    } catch {
      // TTL remains the fallback when Redis is unavailable during shutdown.
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const abortController of this.#s3AbortControllers) abortController.abort();
    this.#s3.destroy();
    if (this.#redis.status !== 'end') this.#redis.disconnect(false);
    try {
      await within(this.#singleFlight.wait(), this.environment.DEPENDENCY_TIMEOUT_MS);
    } catch {
      // In-flight probes are transport-bounded; shutdown does not wait beyond its deadline.
    }
    try {
      await within(this.#prisma.$disconnect(), this.environment.DEPENDENCY_TIMEOUT_MS);
    } catch {
      // Shutdown remains bounded even when the database transport is unhealthy.
    }
  }
}
