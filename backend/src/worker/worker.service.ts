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
  #probeTimer?: NodeJS.Timeout;

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(WORKER_RUNTIME) private readonly runtime: RuntimeDependencies,
    @Inject(WORKER_LOGGER) private readonly logger: JsonLogger,
  ) {}

  async #heartbeat(): Promise<void> {
    try {
      await this.runtime.writeWorkerHeartbeat();
    } catch {
      this.logger.warn('Worker heartbeat недоступен.', 'WorkerHeartbeat');
    }
  }

  async #probeDependencies(): Promise<void> {
    const [postgres, redis, objectStorage] = await Promise.all([
      this.runtime.checkPostgres(),
      this.runtime.checkRedis(),
      this.runtime.checkObjectStorage(),
    ]);
    const result =
      postgres === 'up' && redis === 'up' && objectStorage === 'up' ? 'ready' : 'degraded';
    this.logger
      .child({
        module: 'platform',
        operation: 'worker.dependencies',
        result,
        postgres,
        redis,
        objectStorage,
      })
      .info('Проверка зависимостей worker завершена.');
  }

  async onApplicationBootstrap(): Promise<void> {
    await Promise.all([this.#heartbeat(), this.#probeDependencies()]);
    this.#heartbeatTimer = setInterval(
      () => void this.#heartbeat(),
      this.environment.WORKER_HEARTBEAT_INTERVAL_MS,
    );
    this.#probeTimer = setInterval(() => void this.#probeDependencies(), 30_000);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#probeTimer) clearInterval(this.#probeTimer);
    await this.runtime.deleteWorkerHeartbeat();
    await this.runtime.close();
  }
}
