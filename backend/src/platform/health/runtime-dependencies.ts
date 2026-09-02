import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import type { RuntimeEnvironment } from '../config/env.schema';
import type { ComponentStatus, DependencyProbe } from './health.types';

function databaseUrl(environment: RuntimeEnvironment): string {
  return 'API_DATABASE_URL' in environment
    ? environment.API_DATABASE_URL
    : environment.WORKER_DATABASE_URL;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('DEPENDENCY_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class RuntimeDependencies implements DependencyProbe {
  readonly #prisma: PrismaClient;
  readonly #redis: Redis;
  readonly #s3: S3Client;
  #redisConnection?: Promise<void>;

  constructor(private readonly environment: RuntimeEnvironment) {
    this.#prisma = new PrismaClient({ datasources: { db: { url: databaseUrl(environment) } } });
    this.#redis = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2000),
      connectTimeout: environment.DEPENDENCY_TIMEOUT_MS,
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
    try {
      await within(this.#prisma.$queryRaw`SELECT 1`, this.environment.DEPENDENCY_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  async checkRedis(): Promise<ComponentStatus> {
    try {
      await within(this.#ensureRedisConnection(), this.environment.DEPENDENCY_TIMEOUT_MS);
      await within(this.#redis.ping(), this.environment.DEPENDENCY_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  async checkObjectStorage(): Promise<ComponentStatus> {
    try {
      await within(
        this.#s3.send(new HeadBucketCommand({ Bucket: this.environment.S3_BUCKET })),
        this.environment.DEPENDENCY_TIMEOUT_MS,
      );
      return 'up';
    } catch {
      return 'down';
    }
  }

  async checkWorkerHeartbeat(): Promise<ComponentStatus> {
    try {
      await within(this.#ensureRedisConnection(), this.environment.DEPENDENCY_TIMEOUT_MS);
      const heartbeat = await within(
        this.#redis.get(this.environment.WORKER_HEARTBEAT_KEY),
        this.environment.DEPENDENCY_TIMEOUT_MS,
      );
      return heartbeat ? 'up' : 'down';
    } catch {
      return 'down';
    }
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
    await this.#prisma.$disconnect();
    if (this.#redis.status !== 'end') this.#redis.disconnect(false);
    this.#s3.destroy();
  }
}
