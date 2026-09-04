import 'reflect-metadata';
import { createApiApplication } from './app';
import { parseApiEnvironment } from '../platform/config/env.schema';
import { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import { JsonLogger, sanitizeLogMessage } from '../platform/observability/json-logger';

async function bootstrap(): Promise<void> {
  const environment = parseApiEnvironment(process.env);
  const logger = new JsonLogger('api', environment.LOG_LEVEL);
  const runtime = new RuntimeDependencies(environment);
  const startedAt = performance.now();
  const [postgres, redis, objectStorage, worker] = await Promise.all([
    runtime.checkPostgres(),
    runtime.checkRedis(),
    runtime.checkObjectStorage(),
    runtime.checkWorkerHeartbeat(),
  ]);
  const result =
    postgres === 'down'
      ? 'unavailable'
      : redis === 'down' || objectStorage === 'down' || worker === 'down'
        ? 'degraded'
        : 'ready';
  logger
    .child({
      module: 'platform',
      operation: 'api.dependencies',
      result,
      postgres,
      redis,
      objectStorage,
      worker,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
    })
    .info('Стартовая проверка зависимостей API завершена.');
  const application = await createApiApplication(environment, { logger, probe: runtime });
  await application.listen(environment.API_PORT, '0.0.0.0');
  logger.log(`API принимает соединения на порту ${environment.API_PORT}.`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${sanitizeLogMessage(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
