import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from './platform/health/health.module';
import type { DependencyProbe } from './platform/health/health.types';
import type { ApiEnvironment } from './platform/config/env.schema';
import { DatabaseModule } from './platform/database/database.module';
import { IdentityModule } from './modules/identity';
import { MetricsRuntime } from './platform/observability/metrics-runtime';

@Module({})
export class AppModule {
  static register(
    probe: DependencyProbe,
    environment: ApiEnvironment,
    metricsRuntime?: MetricsRuntime,
  ): DynamicModule {
    return {
      module: AppModule,
      providers: metricsRuntime ? [{ provide: MetricsRuntime, useValue: metricsRuntime }] : [],
      imports: [
        DatabaseModule.register(environment),
        IdentityModule.register(environment),
        HealthModule.register(probe),
      ],
    };
  }
}
