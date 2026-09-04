import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import type { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WORKER_ENVIRONMENT, WORKER_LOGGER, WORKER_RUNTIME } from './worker.tokens';

@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  #heartbeatTimer?: NodeJS.Timeout;
  #heartbeatRefresh?: Promise<void>;
  #shuttingDown = false;
  #lastDependencyResult?: 'ready' | 'degraded';

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(WORKER_RUNTIME) private readonly runtime: RuntimeDependencies,
    @Inject(WORKER_LOGGER) private readonly logger: JsonLogger,
  ) {}

  async #refreshHeartbeat(): Promise<void> {
    const startedAt = performance.now();
    const [postgres, redis, objectStorage] = await Promise.all([
      this.runtime.checkPostgres(),
      this.runtime.checkRedis(),
      this.runtime.checkObjectStorage(),
    ]);
    const result =
      postgres === 'up' && redis === 'up' && objectStorage === 'up' ? 'ready' : 'degraded';

    if (result === 'ready') {
      try {
        await this.runtime.writeWorkerHeartbeat();
      } catch {
        this.logger.warn('Worker heartbeat недоступен.', 'WorkerHeartbeat');
      }
    }

    if (result !== this.#lastDependencyResult) {
      this.logger
        .child({
          module: 'platform',
          operation: 'worker.dependencies',
          result,
          postgres,
          redis,
          objectStorage,
          latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        })
        .info('Проверка зависимостей worker завершена.');
      this.#lastDependencyResult = result;
    }
  }

  #scheduleHeartbeat(): void {
    if (this.#shuttingDown) return;
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatRefresh = this.#refreshHeartbeat().finally(() => {
        this.#heartbeatRefresh = undefined;
        this.#scheduleHeartbeat();
      });
    }, this.environment.WORKER_HEARTBEAT_INTERVAL_MS);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.#refreshHeartbeat();
    this.#scheduleHeartbeat();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer);
    await this.#heartbeatRefresh;
    await this.runtime.close();
  }
}
