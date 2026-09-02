import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const commonSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('ru-central-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString,
  DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1500),
  WORKER_HEARTBEAT_KEY: z.string().min(1).default('platform:worker:heartbeat'),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5000),
  WORKER_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().min(2).max(300).default(15),
  OTEL_SERVICE_NAME: z.string().min(1).default('komanda-mpei'),
});

const apiSchema = commonSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  API_DATABASE_URL: z.string().url(),
});

const workerSchema = commonSchema.extend({
  WORKER_DATABASE_URL: z.string().url(),
});

export type ApiEnvironment = z.output<typeof apiSchema>;
export type WorkerEnvironment = z.output<typeof workerSchema>;
export type RuntimeEnvironment = ApiEnvironment | WorkerEnvironment;

function parseEnvironment<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const fields = result.error.issues
    .map((issue) => issue.path.join('.') || 'environment')
    .filter((field, index, values) => values.indexOf(field) === index)
    .join(', ');
  throw new Error(`Некорректная конфигурация окружения: ${fields}.`);
}

export function parseApiEnvironment(source: NodeJS.ProcessEnv): ApiEnvironment {
  return parseEnvironment(apiSchema, source);
}

export function parseWorkerEnvironment(source: NodeJS.ProcessEnv): WorkerEnvironment {
  return parseEnvironment(workerSchema, source);
}
