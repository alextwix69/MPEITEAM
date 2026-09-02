import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from './platform/health/health.module';
import type { DependencyProbe } from './platform/health/health.types';

@Module({})
export class AppModule {
  static register(probe: DependencyProbe): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule.register(probe)],
    };
  }
}
