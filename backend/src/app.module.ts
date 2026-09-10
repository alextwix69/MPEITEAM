import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from './platform/health/health.module';
import type { DependencyProbe } from './platform/health/health.types';
import type { ApiEnvironment } from './platform/config/env.schema';
import { DatabaseModule } from './platform/database/database.module';
import { IdentityModule } from './modules/identity';
import { FilesModule } from './modules/files';
import { MetricsRuntime } from './platform/observability/metrics-runtime';
import { CatalogModule } from './modules/catalog';
import { ProfilesController } from './api/profiles.controller';
import { ProfileWorkflowService } from './api/profile-workflow.service';
import { NotificationsModule } from './modules/notifications';
import { ProfilesModule } from './modules/profiles';

@Module({})
export class AppModule {
  static register(
    probe: DependencyProbe,
    environment: ApiEnvironment,
    metricsRuntime?: MetricsRuntime,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [ProfilesController],
      providers: [
        ...(metricsRuntime ? [{ provide: MetricsRuntime, useValue: metricsRuntime }] : []),
        ProfileWorkflowService,
      ],
      imports: [
        DatabaseModule.register(environment),
        IdentityModule.register(environment),
        ProfilesModule,
        FilesModule.registerApi(environment),
        CatalogModule,
        NotificationsModule.register(environment),
        HealthModule.register(probe),
      ],
    };
  }
}
