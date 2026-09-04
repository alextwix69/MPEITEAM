import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class DatabaseService extends PrismaClient implements OnApplicationShutdown {
  constructor(databaseUrl: string) {
    super({ datasources: { db: { url: databaseUrl } } });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
