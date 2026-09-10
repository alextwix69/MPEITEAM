import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnvironment, WorkerEnvironment } from '../config/env.schema';
import { DatabaseService } from './database.service';

@Global()
@Module({})
export class DatabaseModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return this.registerUrl(environment.API_DATABASE_URL);
  }

  static registerWorker(environment: WorkerEnvironment): DynamicModule {
    return this.registerUrl(environment.WORKER_DATABASE_URL);
  }

  private static registerUrl(databaseUrl: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DatabaseService,
          useFactory: () => new DatabaseService(databaseUrl),
        },
      ],
      exports: [DatabaseService],
    };
  }
}
