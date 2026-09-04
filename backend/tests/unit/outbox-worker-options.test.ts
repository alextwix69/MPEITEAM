import { describe, expect, it } from 'vitest';
import { parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import { queueRedisOptions, workerRedisOptions } from '../../src/worker/outbox-worker.service';

const environment = parseWorkerEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://127.0.0.1:1',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  WORKER_DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/app?connection_limit=2',
  LEGAL_DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/legal?connection_limit=2',
  DEPENDENCY_TIMEOUT_MS: '250',
});

describe('outbox Redis connection roles', () => {
  it('fails dispatcher commands quickly while allowing the BullMQ worker to reconnect', () => {
    expect(queueRedisOptions(environment)).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 250,
    });
    expect(workerRedisOptions()).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  });
});
