import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnvironment, WorkerEnvironment } from '../../platform/config/env.schema';
import { ProfilesModule } from '../profiles';
import { FilesService } from './application/files.service';
import { FilesController } from './http/files.controller';
import { FilesWorkerService } from './worker/files-worker.service';
import { FILES_ENVIRONMENT, MALWARE_SCANNER, UPLOAD_RATE_LIMITER } from './files.tokens';
import { ClamAvMalwareScanner } from './infrastructure/malware-scanner.adapter';
import { objectStorageProvider } from './infrastructure/s3-storage.adapter';
import { RedisUploadRateLimiter } from './infrastructure/upload-rate-limiter';

@Module({})
export class FilesModule {
  static registerApi(environment: ApiEnvironment): DynamicModule {
    return {
      module: FilesModule,
      imports: [ProfilesModule],
      controllers: [FilesController],
      providers: [
        FilesService,
        objectStorageProvider,
        { provide: UPLOAD_RATE_LIMITER, useClass: RedisUploadRateLimiter },
        { provide: FILES_ENVIRONMENT, useValue: environment },
      ],
      exports: [FilesService],
    };
  }

  static registerWorker(environment: WorkerEnvironment): DynamicModule {
    return {
      module: FilesModule,
      providers: [
        FilesWorkerService,
        objectStorageProvider,
        { provide: MALWARE_SCANNER, useClass: ClamAvMalwareScanner },
        { provide: FILES_ENVIRONMENT, useValue: environment },
      ],
    };
  }
}
