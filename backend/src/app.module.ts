import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from './platform/health/health.module';
import type { DependencyProbe } from './platform/health/health.types';
import type { ApiEnvironment } from './platform/config/env.schema';
import { DatabaseModule } from './platform/database/database.module';
import { IdentityModule } from './modules/identity';

@Module({})
export class AppModule {
  static register(probe: DependencyProbe, environment: ApiEnvironment): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.register(environment),
        IdentityModule.register(environment),
        HealthModule.register(probe),
      ],
    };
  }
}
