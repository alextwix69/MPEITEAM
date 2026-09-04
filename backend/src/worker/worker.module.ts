import { Module, type DynamicModule } from '@nestjs/common';
import { ComplianceModule } from '../modules/compliance';
import { EMAIL_SENDER, SmtpEmailSender } from '../modules/identity';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import type { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WorkerService } from './worker.service';
import { WORKER_ENVIRONMENT, WORKER_LOGGER, WORKER_RUNTIME } from './worker.tokens';
import { OutboxWorkerService } from './outbox-worker.service';

@Module({})
export class WorkerModule {
  static register(
    environment: WorkerEnvironment,
    runtime: RuntimeDependencies,
    logger: JsonLogger,
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [ComplianceModule.register(environment)],
      providers: [
        WorkerService,
        OutboxWorkerService,
        {
          provide: EMAIL_SENDER,
          useFactory: () => new SmtpEmailSender(environment.SMTP_URL, environment.EMAIL_FROM),
        },
        { provide: WORKER_ENVIRONMENT, useValue: environment },
        { provide: WORKER_RUNTIME, useValue: runtime },
        { provide: WORKER_LOGGER, useValue: logger },
      ],
    };
  }
}
