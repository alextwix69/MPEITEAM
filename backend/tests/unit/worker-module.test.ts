import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import type { RuntimeDependencies } from '../../src/platform/health/runtime-dependencies';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { WorkerModule } from '../../src/worker/worker.module';

describe('worker module wiring', () => {
  it('resolves moderation and notification workers without module cycles', async () => {
    const environment = parseWorkerEnvironment({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_DATABASE_URL: 'postgresql://user:pass@localhost/db?connection_limit=2',
      LEGAL_DATABASE_URL: 'postgresql://user:pass@localhost/legal?connection_limit=2',
      REDIS_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'komanda-media',
      S3_ACCESS_KEY: 'local',
      S3_SECRET_KEY: 'secret',
      LEGAL_SUBJECT_HMAC_KEY: 'worker-module-legal-key-00000000001',
      SMTP_URL: 'smtp://localhost:1025',
    });
    const runtime = {
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeDependencies;
    const module = await Test.createTestingModule({
      imports: [WorkerModule.register(environment, runtime, new JsonLogger('worker', 'silent'))],
    }).compile();
    expect(module).toBeDefined();
    await module.close();
  });
});
