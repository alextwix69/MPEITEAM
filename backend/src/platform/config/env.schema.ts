import { z } from 'zod';

function urlWithProtocols(protocols: readonly string[]) {
  return z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: 'unsupported protocol' },
    );
}

const databaseUrlSchema = urlWithProtocols(['postgres:', 'postgresql:']).superRefine(
  (value, context) => {
    let connectionLimit: string | null;
    try {
      connectionLimit = new URL(value).searchParams.get('connection_limit');
    } catch {
      return;
    }
    if (!connectionLimit || !/^[1-9]\d*$/u.test(connectionLimit)) {
      context.addIssue({
        code: 'custom',
        message: 'connection_limit must be a positive integer',
      });
    }
  },
);
const redisUrlSchema = urlWithProtocols(['redis:', 'rediss:']);
const objectStorageUrlSchema = urlWithProtocols(['http:', 'https:']);
const smtpUrlSchema = urlWithProtocols(['smtp:', 'smtps:']);

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const commonSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    REDIS_URL: redisUrlSchema,
    S3_ENDPOINT: objectStorageUrlSchema,
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
  })
  .superRefine((value, context) => {
    const maximumHeartbeatGapMs =
      value.WORKER_HEARTBEAT_INTERVAL_MS + 2 * value.DEPENDENCY_TIMEOUT_MS;
    if (value.WORKER_HEARTBEAT_TTL_SECONDS * 1000 <= maximumHeartbeatGapMs) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_HEARTBEAT_TTL_SECONDS'],
        message: 'heartbeat TTL must exceed interval and dependency checks',
      });
    }
  });

const apiSchema = commonSchema
  .safeExtend({
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    API_DATABASE_URL: databaseUrlSchema,
    AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
    AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(86_400),
    AUTH_TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .default('0000000000000000000000000000000000000000000000000000000000000000'),
    IDEMPOTENCY_HMAC_KEY: z.string().min(32).default('local-idempotency-key-change-me-0001'),
    CONSENT_VERSION_AGE_18: z.string().min(1).max(64).default('local-v1'),
    CONSENT_VERSION_USER_TERMS: z.string().min(1).max(64).default('local-v1'),
    CONSENT_VERSION_PERSONAL_DATA: z.string().min(1).max(64).default('local-v1'),
    CONSENT_VERSION_PUBLIC_PROFILE: z.string().min(1).max(64).default('local-v1'),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1000).default(20),
    RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    SESSION_COOKIE_SECURE: booleanFromString,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production') {
      if (/^0{64}$/u.test(value.AUTH_TOKEN_ENCRYPTION_KEY)) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_TOKEN_ENCRYPTION_KEY'],
          message: 'production key required',
        });
      }
      if (value.IDEMPOTENCY_HMAC_KEY.startsWith('local-')) {
        context.addIssue({
          code: 'custom',
          path: ['IDEMPOTENCY_HMAC_KEY'],
          message: 'production key required',
        });
      }
      if (!value.SESSION_COOKIE_SECURE) {
        context.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_SECURE'],
          message: 'secure cookie required',
        });
      }
    }
  });

const workerSchema = commonSchema
  .safeExtend({
    WORKER_DATABASE_URL: databaseUrlSchema,
    LEGAL_DATABASE_URL: databaseUrlSchema.default(
      'postgresql://komanda_legal:komanda-legal-local@localhost:5432/komanda_legal?connection_limit=2',
    ),
    LEGAL_SUBJECT_HMAC_KEY: z.string().min(32).default('local-legal-subject-key-change-me-01'),
    AUTH_TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .default('0000000000000000000000000000000000000000000000000000000000000000'),
    SMTP_URL: smtpUrlSchema.default('smtp://localhost:1025'),
    EMAIL_FROM: z.string().email().default('no-reply@komanda.mpei.ru'),
    PUBLIC_APP_URL: objectStorageUrlSchema.default('http://localhost:8080'),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production') {
      if (/^0{64}$/u.test(value.AUTH_TOKEN_ENCRYPTION_KEY)) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_TOKEN_ENCRYPTION_KEY'],
          message: 'production key required',
        });
      }
      if (value.LEGAL_SUBJECT_HMAC_KEY.startsWith('local-')) {
        context.addIssue({
          code: 'custom',
          path: ['LEGAL_SUBJECT_HMAC_KEY'],
          message: 'production key required',
        });
      }
    }
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
