import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { version } from 'uuid';
import { createApiApplication } from '../../src/api/app';
import type { ApiEnvironment } from '../../src/platform/config/env.schema';
import type { ComponentStatus, DependencyProbe } from '../../src/platform/health/health.types';
import { JsonLogger } from '../../src/platform/observability/json-logger';

const environment: ApiEnvironment = {
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
  OTEL_SERVICE_NAME: 'test',
  API_PORT: 3001,
  API_DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
};

let application: INestApplication | undefined;

function fakeProbe(
  statuses: Partial<
    Record<'postgres' | 'redis' | 'objectStorage' | 'worker', ComponentStatus>
  > = {},
): DependencyProbe {
  return {
    checkPostgres: vi.fn(async () => statuses.postgres ?? 'up'),
    checkRedis: vi.fn(async () => statuses.redis ?? 'up'),
    checkObjectStorage: vi.fn(async () => statuses.objectStorage ?? 'up'),
    checkWorkerHeartbeat: vi.fn(async () => statuses.worker ?? 'up'),
    close: vi.fn(async () => undefined),
  };
}

async function boot(probe: DependencyProbe) {
  application = await createApiApplication(environment, {
    probe,
    logger: new JsonLogger('api', 'silent'),
  });
  await application.init();
  return request(application.getHttpServer());
}

afterEach(async () => {
  await application?.close();
  application = undefined;
});

describe('health HTTP API', () => {
  it('keeps liveness independent from failed probes and returns UUIDv7', async () => {
    const probe = fakeProbe();
    vi.mocked(probe.checkPostgres).mockRejectedValue(new Error('database URL must stay private'));
    const response = await (await boot(probe)).get('/health/live').set('X-Request-Id', 'invalid');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(version(response.headers['x-request-id'] as string)).toBe(7);
    expect(probe.checkPostgres).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 200, 'ready'],
    [{ redis: 'down' } as const, 200, 'degraded'],
    [{ objectStorage: 'down' } as const, 200, 'degraded'],
    [{ worker: 'down' } as const, 200, 'degraded'],
    [{ postgres: 'down' } as const, 503, 'unavailable'],
  ])('reports dependency snapshot %j', async (statuses, expectedStatus, expectedBodyStatus) => {
    const response = await (await boot(fakeProbe(statuses))).get('/health/ready');
    expect(response.status).toBe(expectedStatus);
    expect(response.body.status).toBe(expectedBodyStatus);
    expect(JSON.stringify(response.body)).not.toContain('postgresql://');
    expect(JSON.stringify(response.body)).not.toContain('redis://');
  });

  it('uses the documented problem envelope for unknown business paths', async () => {
    const requestId = '018f47a8-7b8c-7c14-a9cc-0242ac120002';
    const response = await (
      await boot(fakeProbe())
    )
      .get('/api/v1/not-implemented')
      .set('X-Request-Id', requestId);

    expect(response.status).toBe(404);
    expect(response.type).toBe('application/problem+json');
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Запрошенный ресурс не найден.',
        requestId,
        retryable: false,
      },
    });
  });
});
