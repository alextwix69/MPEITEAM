import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import type { RuntimeDependencies } from '../../src/platform/health/runtime-dependencies';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { WorkerService } from '../../src/worker/worker.service';

const environment = parseWorkerEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ru-central-1',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  S3_FORCE_PATH_STYLE: 'true',
  DEPENDENCY_TIMEOUT_MS: '500',
  WORKER_HEARTBEAT_KEY: 'platform:worker:heartbeat',
  WORKER_HEARTBEAT_INTERVAL_MS: '5000',
  WORKER_HEARTBEAT_TTL_SECONDS: '15',
  OTEL_SERVICE_NAME: 'test-worker',
  WORKER_DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?connection_limit=3',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker lifecycle', () => {
  it('writes an operational heartbeat only when worker dependencies are ready', async () => {
    vi.useFakeTimers();
    const runtime = {
      writeWorkerHeartbeat: vi.fn(async () => undefined),
      checkPostgres: vi.fn(async () => 'up' as const),
      checkRedis: vi.fn(async () => 'up' as const),
      checkObjectStorage: vi.fn(async () => 'up' as const),
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeDependencies;
    const worker = new WorkerService(environment, runtime, new JsonLogger('worker', 'silent'));

    await worker.onApplicationBootstrap();
    expect(runtime.writeWorkerHeartbeat).toHaveBeenCalledOnce();
    expect(runtime.checkPostgres).toHaveBeenCalledOnce();

    await worker.onApplicationShutdown();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it('does not advertise a worker whose database is unavailable', async () => {
    vi.useFakeTimers();
    const runtime = {
      writeWorkerHeartbeat: vi.fn(async () => undefined),
      checkPostgres: vi.fn(async () => 'down' as const),
      checkRedis: vi.fn(async () => 'up' as const),
      checkObjectStorage: vi.fn(async () => 'up' as const),
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeDependencies;
    const worker = new WorkerService(environment, runtime, new JsonLogger('worker', 'silent'));

    await worker.onApplicationBootstrap();

    expect(runtime.writeWorkerHeartbeat).not.toHaveBeenCalled();
    await worker.onApplicationShutdown();
  });

  it('stops refreshing the heartbeat after a dependency becomes unavailable', async () => {
    vi.useFakeTimers();
    const runtime = {
      writeWorkerHeartbeat: vi.fn(async () => undefined),
      checkPostgres: vi
        .fn<() => Promise<'up' | 'down'>>()
        .mockResolvedValueOnce('up')
        .mockResolvedValue('down'),
      checkRedis: vi.fn(async () => 'up' as const),
      checkObjectStorage: vi.fn(async () => 'up' as const),
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeDependencies;
    const worker = new WorkerService(environment, runtime, new JsonLogger('worker', 'silent'));

    await worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(environment.WORKER_HEARTBEAT_INTERVAL_MS);

    expect(runtime.checkPostgres).toHaveBeenCalledTimes(2);
    expect(runtime.writeWorkerHeartbeat).toHaveBeenCalledOnce();
    await worker.onApplicationShutdown();
  });
});
