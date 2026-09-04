import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseApiEnvironment, parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import { RuntimeDependencies } from '../../src/platform/health/runtime-dependencies';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { WorkerService } from '../../src/worker/worker.service';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2';

const common = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'ru-central-1',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'komanda-local',
  S3_SECRET_KEY: 'komanda-local-secret',
  S3_FORCE_PATH_STYLE: 'true',
  DEPENDENCY_TIMEOUT_MS: '1000',
  WORKER_HEARTBEAT_INTERVAL_MS: '5000',
  WORKER_HEARTBEAT_TTL_SECONDS: '15',
  OTEL_SERVICE_NAME: 'komanda-mpei-integration',
};

const runtimes: RuntimeDependencies[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('runtime dependencies', () => {
  it('probes the migrated test database, Redis and object storage with real clients', async () => {
    const environment = parseApiEnvironment({
      ...common,
      API_PORT: '3001',
      API_DATABASE_URL: databaseUrl,
      WORKER_HEARTBEAT_KEY: `test:worker:heartbeat:${randomUUID()}`,
    });
    const runtime = new RuntimeDependencies(environment);
    runtimes.push(runtime);

    await expect(
      Promise.all([runtime.checkPostgres(), runtime.checkRedis(), runtime.checkObjectStorage()]),
    ).resolves.toEqual(['up', 'up', 'up']);
  });

  it('does not publish a heartbeat when the worker database cannot be used', async () => {
    const environment = parseWorkerEnvironment({
      ...common,
      DEPENDENCY_TIMEOUT_MS: '500',
      WORKER_DATABASE_URL:
        'postgresql://komanda:komanda@127.0.0.1:1/unavailable?connection_limit=2&connect_timeout=1&pool_timeout=1',
      WORKER_HEARTBEAT_KEY: `test:worker:heartbeat:${randomUUID()}`,
    });
    const runtime = new RuntimeDependencies(environment);
    runtimes.push(runtime);
    const worker = new WorkerService(environment, runtime, new JsonLogger('worker', 'silent'));

    await worker.onApplicationBootstrap();

    await expect(runtime.checkWorkerHeartbeat()).resolves.toBe('down');
    await worker.onApplicationShutdown();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  });

  it('expires a real Redis heartbeat when no worker refreshes it', async () => {
    const environment = parseApiEnvironment({
      ...common,
      DEPENDENCY_TIMEOUT_MS: '500',
      WORKER_HEARTBEAT_INTERVAL_MS: '500',
      WORKER_HEARTBEAT_TTL_SECONDS: '2',
      API_PORT: '3001',
      API_DATABASE_URL: databaseUrl,
      WORKER_HEARTBEAT_KEY: `test:worker:heartbeat:${randomUUID()}`,
    });
    const runtime = new RuntimeDependencies(environment);
    runtimes.push(runtime);

    await runtime.writeWorkerHeartbeat();
    await expect(runtime.checkWorkerHeartbeat()).resolves.toBe('up');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await expect(runtime.checkWorkerHeartbeat()).resolves.toBe('down');
  });

  it('closes real dependency clients without allowing readiness to reconnect them', async () => {
    const environment = parseApiEnvironment({
      ...common,
      API_PORT: '3001',
      API_DATABASE_URL: databaseUrl,
      WORKER_HEARTBEAT_KEY: `test:worker:heartbeat:${randomUUID()}`,
    });
    const runtime = new RuntimeDependencies(environment);
    runtimes.push(runtime);
    await Promise.all([
      runtime.checkPostgres(),
      runtime.checkRedis(),
      runtime.checkObjectStorage(),
    ]);

    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    await expect(
      Promise.all([runtime.checkPostgres(), runtime.checkRedis(), runtime.checkObjectStorage()]),
    ).resolves.toEqual(['down', 'down', 'down']);
  });
});
