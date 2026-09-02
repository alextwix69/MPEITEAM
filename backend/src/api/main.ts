import 'reflect-metadata';
import { createApiApplication } from './app';
import { parseApiEnvironment } from '../platform/config/env.schema';
import { JsonLogger, sanitizeLogMessage } from '../platform/observability/json-logger';

async function bootstrap(): Promise<void> {
  const environment = parseApiEnvironment(process.env);
  const logger = new JsonLogger('api', environment.LOG_LEVEL);
  const application = await createApiApplication(environment, { logger });
  await application.listen(environment.API_PORT, '0.0.0.0');
  logger.log(`API принимает соединения на порту ${environment.API_PORT}.`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${sanitizeLogMessage(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
