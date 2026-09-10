import { Module, type DynamicModule } from '@nestjs/common';
import { ComplianceModule } from '../modules/compliance';
import { EMAIL_SENDER, IdentityModule, SmtpEmailSender } from '../modules/identity';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import type { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WorkerService } from './worker.service';
import { WORKER_ENVIRONMENT, WORKER_LOGGER, WORKER_RUNTIME } from './worker.tokens';
import { OutboxWorkerService } from './outbox-worker.service';
import { MetricsRuntime } from '../platform/observability/metrics-runtime';
import { FilesModule } from '../modules/files';
import { DatabaseModule } from '../platform/database/database.module';
import { TrustModule } from '../modules/trust';
import { NotificationsModule } from '../modules/notifications';
import { ModerationWorkerService } from './moderation-worker.service';
import { EmailDeliveryWorkerService } from './email-delivery-worker.service';
import { ProfilesModule } from '../modules/profiles';

@Module({})
export class WorkerModule {
  static register(
    environment: WorkerEnvironment,
    runtime: RuntimeDependencies,
    logger: JsonLogger,
    metricsRuntime?: MetricsRuntime,
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.registerWorker(environment),
        ComplianceModule.register(environment),
        FilesModule.registerWorker(environment, logger),
        ProfilesModule,
        TrustModule.register(environment),
        NotificationsModule.register(environment, false),
        IdentityModule.registerWorker(),
      ],
      providers: [
        ...(metricsRuntime ? [{ provide: MetricsRuntime, useValue: metricsRuntime }] : []),
        WorkerService,
        OutboxWorkerService,
        ModerationWorkerService,
        EmailDeliveryWorkerService,
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
