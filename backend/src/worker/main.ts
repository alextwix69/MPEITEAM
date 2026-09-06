import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseWorkerEnvironment } from '../platform/config/env.schema';
import { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import { JsonLogger, sanitizeLogMessage } from '../platform/observability/json-logger';
import { MetricsRuntime } from '../platform/observability/metrics-runtime';

let metricsRuntime: MetricsRuntime | undefined;

async function bootstrap(): Promise<void> {
  const environment = parseWorkerEnvironment(process.env);
  metricsRuntime = await MetricsRuntime.start(environment, 'worker');
  const { WorkerModule } = await import('./worker.module');
  const logger = new JsonLogger('worker', environment.LOG_LEVEL);
  const runtime = new RuntimeDependencies(environment);
  const application = await NestFactory.createApplicationContext(
    WorkerModule.register(environment, runtime, logger, metricsRuntime),
    { bufferLogs: true, logger },
  );
  application.enableShutdownHooks();
  logger.log('Worker запущен.', 'Bootstrap');
}

bootstrap().catch(async (error: unknown) => {
  await metricsRuntime?.onApplicationShutdown();
  process.stderr.write(`${sanitizeLogMessage(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
