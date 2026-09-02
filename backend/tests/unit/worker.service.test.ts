import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnvironment } from '../../src/platform/config/env.schema';
import type { RuntimeDependencies } from '../../src/platform/health/runtime-dependencies';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { WorkerService } from '../../src/worker/worker.service';

const environment: WorkerEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ru-central-1',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  S3_FORCE_PATH_STYLE: true,
  DEPENDENCY_TIMEOUT_MS: 500,
  WORKER_HEARTBEAT_KEY: 'platform:worker:heartbeat',
  WORKER_HEARTBEAT_INTERVAL_MS: 5000,
  WORKER_HEARTBEAT_TTL_SECONDS: 15,
  OTEL_SERVICE_NAME: 'test-worker',
  WORKER_DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?connection_limit=3',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('worker lifecycle', () => {
  it('writes an operational heartbeat and closes every client on shutdown', async () => {
    vi.useFakeTimers();
    const runtime = {
      writeWorkerHeartbeat: vi.fn(async () => undefined),
      checkPostgres: vi.fn(async () => 'up' as const),
      checkRedis: vi.fn(async () => 'up' as const),
      checkObjectStorage: vi.fn(async () => 'up' as const),
      deleteWorkerHeartbeat: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeDependencies;
    const worker = new WorkerService(environment, runtime, new JsonLogger('worker', 'silent'));

    await worker.onApplicationBootstrap();
    expect(runtime.writeWorkerHeartbeat).toHaveBeenCalledOnce();
    expect(runtime.checkPostgres).toHaveBeenCalledOnce();

    await worker.onApplicationShutdown();
    expect(runtime.deleteWorkerHeartbeat).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
