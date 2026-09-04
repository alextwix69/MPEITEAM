import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnvironment } from '../../platform/config/env.schema';
import { ProfilesModule } from '../profiles';
import { IdentityService } from './application/identity.service';
import { IdentityController } from './http/identity.controller';
import { IDENTITY_ENVIRONMENT } from './identity.tokens';
import { RateLimitService } from './infrastructure/rate-limit.service';

@Module({})
export class IdentityModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: IdentityModule,
      imports: [ProfilesModule],
      controllers: [IdentityController],
      providers: [
        IdentityService,
        RateLimitService,
        { provide: IDENTITY_ENVIRONMENT, useValue: environment },
      ],
      exports: [IdentityService],
    };
  }
}
