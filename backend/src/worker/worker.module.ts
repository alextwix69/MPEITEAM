import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import type { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WorkerService } from './worker.service';
import { WORKER_ENVIRONMENT, WORKER_LOGGER, WORKER_RUNTIME } from './worker.tokens';

@Module({})
export class WorkerModule {
  static register(
    environment: WorkerEnvironment,
    runtime: RuntimeDependencies,
    logger: JsonLogger,
  ): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        WorkerService,
        { provide: WORKER_ENVIRONMENT, useValue: environment },
        { provide: WORKER_RUNTIME, useValue: runtime },
        { provide: WORKER_LOGGER, useValue: logger },
      ],
    };
  }
}
