import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { DEPENDENCY_PROBE } from './tokens';
import type { DependencyProbe, ReadinessResponse } from './health.types';

@Injectable()
export class HealthService implements OnApplicationShutdown {
  constructor(@Inject(DEPENDENCY_PROBE) private readonly probe: DependencyProbe) {}

  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(): Promise<ReadinessResponse> {
    const [postgres, redis, objectStorage, worker] = await Promise.all([
      this.probe.checkPostgres(),
      this.probe.checkRedis(),
      this.probe.checkObjectStorage(),
      this.probe.checkWorkerHeartbeat(),
    ]);

    const status =
      postgres === 'down'
        ? 'unavailable'
        : redis === 'down' || objectStorage === 'down' || worker === 'down'
          ? 'degraded'
          : 'ready';

    return {
      status,
      checkedAt: new Date().toISOString(),
      dependencies: {
        postgres: { status: postgres },
        redis: { status: redis },
        objectStorage: { status: objectStorage },
        worker: { status: worker },
      },
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.probe.close();
  }
}
