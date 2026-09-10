import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerEnvironment } from '../../platform/config/env.schema';
import { TrustService } from './application/trust.service';
import { HttpContentModerator } from './infrastructure/http-content-moderator';
import { CONTENT_MODERATOR, TRUST_ENVIRONMENT } from './trust.tokens';

@Module({})
export class TrustModule {
  static register(environment: WorkerEnvironment): DynamicModule {
    return {
      module: TrustModule,
      providers: [
        TrustService,
        HttpContentModerator,
        { provide: CONTENT_MODERATOR, useExisting: HttpContentModerator },
        { provide: TRUST_ENVIRONMENT, useValue: environment },
      ],
      exports: [TrustService, CONTENT_MODERATOR],
    };
  }
}
