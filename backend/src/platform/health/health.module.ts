import { Module, type DynamicModule } from '@nestjs/common';
import { NotFoundController } from '../http/not-found.controller';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import type { DependencyProbe } from './health.types';
import { DEPENDENCY_PROBE } from './tokens';

@Module({})
export class HealthModule {
  static register(probe: DependencyProbe): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController, NotFoundController],
      providers: [HealthService, { provide: DEPENDENCY_PROBE, useValue: probe }],
    };
  }
}
