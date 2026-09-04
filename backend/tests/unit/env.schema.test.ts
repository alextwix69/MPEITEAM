import { describe, expect, it } from 'vitest';
import { parseApiEnvironment, parseWorkerEnvironment } from '../../src/platform/config/env.schema';

const common = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ru-central-1',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local-access',
  S3_SECRET_KEY: 'do-not-print-this-secret',
  S3_FORCE_PATH_STYLE: 'true',
  DEPENDENCY_TIMEOUT_MS: '1000',
  WORKER_HEARTBEAT_KEY: 'platform:worker:heartbeat',
  WORKER_HEARTBEAT_INTERVAL_MS: '5000',
  WORKER_HEARTBEAT_TTL_SECONDS: '15',
  OTEL_SERVICE_NAME: 'komanda-mpei-test',
};

describe('environment validation', () => {
  it('parses independent API and worker database pool URLs', () => {
    const api = parseApiEnvironment({
      ...common,
      API_PORT: '3001',
      API_DATABASE_URL: 'postgresql://user:pass@localhost:5432/api?connection_limit=5',
    });
    const worker = parseWorkerEnvironment({
      ...common,
      WORKER_DATABASE_URL: 'postgresql://user:pass@localhost:5432/worker?connection_limit=3',
    });

    expect(api.API_DATABASE_URL).toContain('connection_limit=5');
    expect(worker.WORKER_DATABASE_URL).toContain('connection_limit=3');
  });

  it('fails before startup when a required variable is missing', () => {
    expect(() => parseApiEnvironment({ ...common, API_PORT: '3001' })).toThrow(
      'Некорректная конфигурация окружения: API_DATABASE_URL.',
    );
  });

  it.each([
    ['missing', 'postgresql://user:pass@localhost:5432/api'],
    ['zero', 'postgresql://user:pass@localhost:5432/api?connection_limit=0'],
    ['not numeric', 'postgresql://user:pass@localhost:5432/api?connection_limit=many'],
  ])('rejects a %s database connection limit', (_case, databaseUrl) => {
    expect(() =>
      parseApiEnvironment({
        ...common,
        API_PORT: '3001',
        API_DATABASE_URL: databaseUrl,
      }),
    ).toThrow('API_DATABASE_URL');
  });

  it('reports invalid values without echoing secrets', () => {
    let message = '';
    try {
      parseWorkerEnvironment({
        ...common,
        LOG_LEVEL: 'everything',
        WORKER_DATABASE_URL: 'not-a-url',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('WORKER_DATABASE_URL');
    expect(message).not.toContain(common.S3_SECRET_KEY);
    expect(message).not.toContain('not-a-url');
  });

  it.each([
    ['REDIS_URL', { REDIS_URL: 'https://redis.example' }],
    ['S3_ENDPOINT', { S3_ENDPOINT: 'ftp://objects.example' }],
    ['WORKER_DATABASE_URL', { WORKER_DATABASE_URL: 'https://database.example' }],
  ])('rejects an unsupported protocol in %s', (field, override) => {
    expect(() =>
      parseWorkerEnvironment({
        ...common,
        WORKER_DATABASE_URL: 'postgresql://user:pass@localhost:5432/worker?connection_limit=3',
        ...override,
      }),
    ).toThrow(field);
  });

  it('rejects a heartbeat TTL that can expire between refreshes', () => {
    expect(() =>
      parseWorkerEnvironment({
        ...common,
        DEPENDENCY_TIMEOUT_MS: '10000',
        WORKER_HEARTBEAT_INTERVAL_MS: '60000',
        WORKER_HEARTBEAT_TTL_SECONDS: '2',
        WORKER_DATABASE_URL: 'postgresql://user:pass@localhost:5432/worker?connection_limit=3',
      }),
    ).toThrow('WORKER_HEARTBEAT_TTL_SECONDS');
  });
});
