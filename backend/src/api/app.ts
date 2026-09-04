import { RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import type { ApiEnvironment } from '../platform/config/env.schema';
import { ProblemDetailsFilter } from '../platform/http/problem-details';
import { requestContextMiddleware } from '../platform/http/request-context';
import type { DependencyProbe } from '../platform/health/health.types';
import { RuntimeDependencies } from '../platform/health/runtime-dependencies';
import { JsonLogger } from '../platform/observability/json-logger';

export interface ApiApplicationOptions {
  probe?: DependencyProbe;
  logger?: JsonLogger;
}

export async function createApiApplication(
  environment: ApiEnvironment,
  options: ApiApplicationOptions = {},
): Promise<INestApplication> {
  const logger = options.logger ?? new JsonLogger('api', environment.LOG_LEVEL);
  const probe = options.probe ?? new RuntimeDependencies(environment);
  const application = await NestFactory.create(AppModule.register(probe, environment), {
    bufferLogs: true,
    logger,
  });

  application.getHttpAdapter().getInstance().set('trust proxy', environment.TRUST_PROXY_HOPS);

  application.use(requestContextMiddleware(logger));
  application.useGlobalFilters(new ProblemDetailsFilter(logger));
  application.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  application.enableShutdownHooks();

  return application;
}
