import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnvironment } from '../config/env.schema';
import { DatabaseService } from './database.service';

@Global()
@Module({})
export class DatabaseModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DatabaseService,
          useFactory: () => new DatabaseService(environment.API_DATABASE_URL),
        },
      ],
      exports: [DatabaseService],
    };
  }
}
