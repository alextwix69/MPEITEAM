import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { ApiEnvironment } from '../../../platform/config/env.schema';
import { ApplicationError } from '../../../platform/http/application-error';
import { hmacSha256 } from '../../../platform/security/crypto';
import { IDENTITY_ENVIRONMENT } from '../identity.tokens';

@Injectable()
export class RateLimitService implements OnApplicationShutdown {
  readonly #redis: Redis;
  #connection?: Promise<void>;

  constructor(@Inject(IDENTITY_ENVIRONMENT) private readonly environment: ApiEnvironment) {
    this.#redis = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: environment.DEPENDENCY_TIMEOUT_MS,
    });
    this.#redis.on('error', () => undefined);
  }

  async consume(operation: string, subject: string): Promise<void> {
    const digest = hmacSha256(this.environment.IDEMPOTENCY_HMAC_KEY, subject).toString('hex');
    const key = `identity:rate:${operation}:${digest}`;
    try {
      await this.#ensureConnection();
      const result = await this.#redis.multi().incr(key).ttl(key).exec();
      const count = Number(result?.[0]?.[1] ?? 0);
      const ttl = Number(result?.[1]?.[1] ?? -1);
      if (ttl < 0) await this.#redis.expire(key, this.environment.RATE_LIMIT_WINDOW_SECONDS);
      if (count > this.environment.RATE_LIMIT_MAX_REQUESTS) {
        throw new ApplicationError(
          'RATE_LIMITED',
          'Слишком много запросов. Повторите попытку позже.',
          429,
          true,
          undefined,
          undefined,
          Math.max(ttl, 1),
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        'RATE_LIMIT_UNAVAILABLE',
        'Проверка безопасности временно недоступна. Повторите попытку позже.',
        503,
        true,
        undefined,
        undefined,
        2,
      );
    }
  }

  async #ensureConnection(): Promise<void> {
    if (this.#redis.status === 'ready') return;
    if (this.#connection) return this.#connection;
    if (this.#redis.status !== 'wait') throw new Error('RATE_LIMIT_REDIS_NOT_READY');
    const connection = this.#redis.connect();
    this.#connection = connection;
    try {
      await connection;
    } finally {
      if (this.#connection === connection) this.#connection = undefined;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#redis.status !== 'end') this.#redis.disconnect(false);
  }
}
