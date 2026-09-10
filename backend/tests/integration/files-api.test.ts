import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../../src/platform/security/crypto';
import { createApiApplication } from '../../src/api/app';
import { parseApiEnvironment, parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import type { DependencyProbe } from '../../src/platform/health/health.types';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { FilesWorkerService } from '../../src/modules/files/worker/files-worker.service';
import { S3StorageAdapter } from '../../src/modules/files/infrastructure/s3-storage.adapter';
import { OBJECT_STORAGE } from '../../src/modules/files/files.tokens';
import type { ObjectStorage } from '../../src/modules/files/application/object-storage.port';
import { RedisUploadRateLimiter } from '../../src/modules/files/infrastructure/upload-rate-limiter';
import { FilesService } from '../../src/modules/files/application/files.service';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=3';
const environment = parseApiEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_PORT: '3001',
  API_DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'komanda-local',
  S3_SECRET_KEY: 'komanda-local-secret',
  S3_FORCE_PATH_STYLE: 'true',
  AUTH_TOKEN_ENCRYPTION_KEY: '1'.repeat(64),
  IDEMPOTENCY_HMAC_KEY: 'files-integration-idempotency-key-0001',
  RATE_LIMIT_MAX_REQUESTS: '1000',
  SESSION_COOKIE_SECURE: 'true',
  TRUST_PROXY_HOPS: '1',
});
const workerEnvironment = parseWorkerEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WORKER_DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'komanda-local',
  S3_SECRET_KEY: 'komanda-local-secret',
  S3_FORCE_PATH_STYLE: 'true',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  EMAIL_FROM: 'no-reply@komanda.mpei.ru',
  PUBLIC_APP_URL: 'http://localhost:8080',
  AUTH_TOKEN_ENCRYPTION_KEY: '1'.repeat(64),
  LEGAL_SUBJECT_HMAC_KEY: 'files-integration-legal-subject-key-0001',
});
const probe: DependencyProbe = {
  checkPostgres: vi.fn(async () => 'up' as const),
  checkRedis: vi.fn(async () => 'up' as const),
  checkObjectStorage: vi.fn(async () => 'up' as const),
  checkWorkerHeartbeat: vi.fn(async () => 'up' as const),
  close: vi.fn(async () => undefined),
};
const registration = {
  email: 'files-student@mpei.ru',
  password: 'very-long-password',
  formalRole: 'student',
  profile: {
    fullName: 'Иван Файлов',
    specialization: 'Энергетика',
    timezone: 'Europe/Moscow',
    institute: 'ИЭТ',
    course: 2,
  },
  consents: [
    { documentType: 'age_18', documentVersion: 'local-v1', accepted: true },
    { documentType: 'user_terms', documentVersion: 'local-v1', accepted: true },
    { documentType: 'personal_data', documentVersion: 'local-v1', accepted: true },
    { documentType: 'public_profile_distribution', documentVersion: 'local-v1', accepted: true },
  ],
};

let application: INestApplication;
let http: ReturnType<typeof request>;
let prisma: PrismaClient;

function cookieFrom(response: request.Response): string {
  return (response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}

async function createActiveAccount(): Promise<{
  accountId: string;
  cookie: string;
  profileId: string;
}> {
  const registered = await http
    .post('/api/v1/auth/registrations')
    .set('Idempotency-Key', crypto.randomUUID())
    .send(registration);
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const accountId = registered.body.accountId as string;
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: accountId, eventType: 'identity.email-verification.requested' },
  });
  const token = decryptSecret(
    environment.AUTH_TOKEN_ENCRYPTION_KEY,
    Buffer.from((event.payload as { encryptedToken: string }).encryptedToken, 'base64'),
  );
  await prisma.outboxDelivery.updateMany({
    where: { consumer: 'compliance.consent-evidence' },
    data: { state: 'completed' },
  });
  const verified = await http
    .post('/api/v1/auth/email-verifications')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ token });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const profile = await prisma.profile.findUniqueOrThrow({ where: { accountId } });
  return { accountId, cookie: cookieFrom(verified), profileId: profile.id };
}

describe('files upload API', () => {
  beforeAll(async () => {
    application = await createApiApplication(environment, {
      probe,
      logger: new JsonLogger('api', 'silent'),
    });
    await application.init();
    http = request(application.getHttpServer());
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  beforeEach(async () => {
    await prisma.mediaDeletionTombstone.deleteMany();
    await prisma.mediaBinding.deleteMany();
    await prisma.mediaObject.deleteMany();
    await prisma.uploadSession.deleteMany();
    await prisma.outboxDelivery.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.resume.deleteMany();
    await prisma.profileVersion.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.session.deleteMany();
    await prisma.authToken.deleteMany();
    await prisma.consentStatus.deleteMany();
    await prisma.credential.deleteMany();
    await prisma.account.deleteMany();
  });

  afterAll(async () => {
    await Promise.all([application.close(), prisma.$disconnect()]);
  });

  it('uploads, sanitizes and downloads a private image through signed URLs', async () => {
    const account = await createActiveAccount();
    const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', account.cookie);
    expect(csrf.status).toBe(200);
    const source = await sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .png()
      .toBuffer();
    const ownerId = crypto.randomUUID();
    const created = await http
      .post('/api/v1/uploads')
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'files-create-1')
      .send({
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerId,
        mimeType: 'image/png',
        sizeBytes: source.length,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const idempotency = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { actorAccountId: account.accountId, route: 'POST /uploads', key: 'files-create-1' },
    });
    expect(idempotency.responseBody).not.toHaveProperty('uploadUrl');
    expect(idempotency.responseSecret).not.toBeNull();
    const replay = await http
      .post('/api/v1/uploads')
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'files-create-1')
      .send({
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerId,
        mimeType: 'image/png',
        sizeBytes: source.length,
      });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.uploadUrl).toBe(created.body.uploadUrl);

    const cors = await fetch(created.body.uploadUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8080',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(cors.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');

    const uploadResponse = await fetch(created.body.uploadUrl, {
      method: 'PUT',
      headers: created.body.uploadHeaders,
      body: source as unknown as BodyInit,
    });
    expect(uploadResponse.status).toBe(200);

    const completed = await http
      .post(`/api/v1/uploads/${created.body.id}/complete`)
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'files-complete-1');
    expect(completed.status, JSON.stringify(completed.body)).toBe(202);
    expect(completed.body.state).toBe('processing');

    const worker = new FilesWorkerService(
      workerEnvironment,
      new S3StorageAdapter(workerEnvironment),
      { scan: async () => 'clean' as const },
      new JsonLogger('worker', 'silent'),
    );
    await worker.processPending();
    await worker.onApplicationShutdown();

    const status = await http
      .get(`/api/v1/uploads/${created.body.id}`)
      .set('Cookie', account.cookie);
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('ready');
    expect(status.body.mediaId).toBeTypeOf('string');

    const download = await http
      .get(`/api/v1/media/${status.body.mediaId}/download-url`)
      .set('Cookie', account.cookie);
    expect(download.status).toBe(200);
    expect(download.headers['cache-control']).toBe('no-store');
    const downloaded = await fetch(download.body.url);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toContain('image/jpeg');
    expect(downloaded.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await downloaded.arrayBuffer()).length).toBeLessThanOrEqual(1024 * 1024);
  });

  it('does not complete an upload when the object is absent or oversized', async () => {
    const account = await createActiveAccount();
    const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', account.cookie);
    const created = await http
      .post('/api/v1/uploads')
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'files-create-2')
      .send({
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerId: crypto.randomUUID(),
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      });
    expect(created.status).toBe(201);
    const completed = await http
      .post(`/api/v1/uploads/${created.body.id}/complete`)
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'files-complete-2');
    expect(completed.status).toBe(409);
    expect(completed.body.error.code).toBe('UPLOAD_OBJECT_MISMATCH');
  });

  it('releases an expired idempotency key for a new upload operation', async () => {
    const account = await createActiveAccount();
    const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', account.cookie);
    const body = {
      contentScope: 'private_message',
      ownerType: 'message_draft',
      ownerId: crypto.randomUUID(),
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    };
    const first = await http
      .post('/api/v1/uploads')
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'expired-key')
      .send(body);
    expect(first.status).toBe(201);
    await prisma.idempotencyRecord.updateMany({
      where: { actorAccountId: account.accountId, route: 'POST /uploads', key: 'expired-key' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const second = await http
      .post('/api/v1/uploads')
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'expired-key')
      .send(body);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('rate limits upload creation by account and IP', async () => {
    const limiter = new RedisUploadRateLimiter({
      ...environment,
      RATE_LIMIT_MAX_REQUESTS: 1,
    });
    const suffix = crypto.randomUUID();
    await limiter.consume(`account-${suffix}`, `ip-${suffix}`);
    await expect(limiter.consume(`account-${suffix}`, `ip-${suffix}`)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });
    limiter.onApplicationShutdown();
  });

  it('does not transition to processing when the session expires during object verification', async () => {
    const account = await createActiveAccount();
    const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', account.cookie);
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const created = await http
      .post('/api/v1/uploads')
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'expiry-race-create')
      .send({
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerId: crypto.randomUUID(),
        mimeType: 'image/png',
        sizeBytes: source.length,
      });
    await fetch(created.body.uploadUrl, {
      method: 'PUT',
      headers: created.body.uploadHeaders,
      body: source as unknown as BodyInit,
    });
    const storage = application.get<ObjectStorage>(OBJECT_STORAGE);
    const originalHead = storage.head.bind(storage);
    vi.spyOn(storage, 'head').mockImplementationOnce(async (objectKey) => {
      const metadata = await originalHead(objectKey);
      await prisma.uploadSession.update({
        where: { id: created.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      return metadata;
    });

    const completed = await http
      .post(`/api/v1/uploads/${created.body.id}/complete`)
      .set('Cookie', account.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .set('Idempotency-Key', 'expiry-race-complete');
    expect(completed.status).toBe(409);
    expect(completed.body.error.code).toBe('UPLOAD_EXPIRED');
    expect(
      (await prisma.uploadSession.findUniqueOrThrow({ where: { id: created.body.id } })).state,
    ).toBe('expired');
  });

  it('claims a processing upload once across concurrent workers', async () => {
    const account = await createActiveAccount();
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();
    const uploadId = crypto.randomUUID();
    await prisma.uploadSession.create({
      data: {
        id: uploadId,
        ownerAccountId: account.accountId,
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerRef: crypto.randomUUID(),
        expectedMime: 'image/png',
        expectedSizeBytes: source.length,
        objectKey: `quarantine/${crypto.randomUUID()}`,
        sourceEtag: 'etag-1',
        state: 'processing',
        expiresAt: new Date(Date.now() + 60_000),
        correlationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      },
    });
    let reads = 0;
    const fakeStorage: ObjectStorage = {
      createUploadUrl: async () => '',
      createDownloadUrl: async () => '',
      head: async () => ({
        contentLength: source.length,
        contentType: 'image/png',
        eTag: 'etag-1',
      }),
      get: async () => {
        reads += 1;
        return source;
      },
      put: async () => undefined,
      delete: async () => undefined,
    };
    const workers = [1, 2].map(
      () =>
        new FilesWorkerService(
          workerEnvironment,
          fakeStorage,
          { scan: async () => 'clean' as const },
          new JsonLogger('worker', 'silent'),
        ),
    );
    await Promise.all(workers.map((worker) => worker.processPending()));
    await Promise.all(workers.map((worker) => worker.onApplicationShutdown()));

    expect(reads).toBe(1);
    expect(await prisma.mediaObject.count({ where: { uploadSessionId: uploadId } })).toBe(1);
  });

  it('retries quarantine deletion after processing has reached a terminal state', async () => {
    const account = await createActiveAccount();
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const uploadId = crypto.randomUUID();
    await prisma.uploadSession.create({
      data: {
        id: uploadId,
        ownerAccountId: account.accountId,
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerRef: crypto.randomUUID(),
        expectedMime: 'image/png',
        expectedSizeBytes: source.length,
        objectKey: `quarantine/${crypto.randomUUID()}`,
        sourceEtag: 'etag-cleanup',
        state: 'processing',
        expiresAt: new Date(Date.now() + 60_000),
        correlationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      },
    });
    let quarantineDeletes = 0;
    const worker = new FilesWorkerService(
      workerEnvironment,
      {
        createUploadUrl: async () => '',
        createDownloadUrl: async () => '',
        head: async () => ({
          contentLength: source.length,
          contentType: 'image/png',
          eTag: 'etag-cleanup',
        }),
        get: async () => source,
        put: async () => undefined,
        delete: async (key) => {
          if (key.startsWith('quarantine/')) {
            quarantineDeletes += 1;
            if (quarantineDeletes <= 2) throw new Error('temporary storage failure');
          }
        },
      },
      { scan: async () => 'clean' as const },
      new JsonLogger('worker', 'silent'),
    );
    await worker.processPending();
    expect(
      (await prisma.uploadSession.findUniqueOrThrow({ where: { id: uploadId } }))
        .quarantineDeletedAt,
    ).toBeNull();
    await worker.processPending();
    await worker.onApplicationShutdown();
    expect(
      (await prisma.uploadSession.findUniqueOrThrow({ where: { id: uploadId } }))
        .quarantineDeletedAt,
    ).not.toBeNull();
  });

  it('does not reset a completed deletion tombstone', async () => {
    const account = await createActiveAccount();
    const uploadId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    await prisma.uploadSession.create({
      data: {
        id: uploadId,
        ownerAccountId: account.accountId,
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerRef: crypto.randomUUID(),
        expectedMime: 'image/jpeg',
        expectedSizeBytes: 10,
        objectKey: `quarantine/${crypto.randomUUID()}`,
        state: 'technically_ready',
        expiresAt: new Date(Date.now() + 60_000),
        quarantineDeletedAt: new Date(),
        correlationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      },
    });
    await prisma.mediaObject.create({
      data: {
        id: mediaId,
        uploadSessionId: uploadId,
        uploaderAccountId: account.accountId,
        contentScope: 'private_message',
        state: 'deleting',
        bucket: 'komanda-media',
        objectKey: `media/${mediaId}.jpg`,
        sha256: Buffer.alloc(32),
        mime: 'image/jpeg',
        sizeBytes: 10,
        width: 1,
        height: 1,
        retentionClass: 'message_photo',
      },
    });
    await prisma.mediaDeletionTombstone.create({
      data: {
        mediaId,
        bucket: 'komanda-media',
        objectKey: `media/${mediaId}.jpg`,
        state: 'completed',
        availableAt: new Date(),
        completedAt: new Date(),
      },
    });

    await application.get(FilesService).queueDeletion(mediaId);

    expect(await prisma.mediaObject.findUnique({ where: { id: mediaId } })).toBeNull();
    expect(
      (await prisma.mediaDeletionTombstone.findUniqueOrThrow({ where: { mediaId } })).state,
    ).toBe('completed');
  });

  it('reclaims an expired tombstone lease and removes binding and media metadata', async () => {
    const account = await createActiveAccount();
    const uploadId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    await prisma.uploadSession.create({
      data: {
        id: uploadId,
        ownerAccountId: account.accountId,
        contentScope: 'private_message',
        ownerType: 'message_draft',
        ownerRef: crypto.randomUUID(),
        expectedMime: 'image/jpeg',
        expectedSizeBytes: 10,
        objectKey: `quarantine/${crypto.randomUUID()}`,
        state: 'technically_ready',
        expiresAt: new Date(Date.now() + 60_000),
        quarantineDeletedAt: new Date(),
        correlationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      },
    });
    await prisma.mediaObject.create({
      data: {
        id: mediaId,
        uploadSessionId: uploadId,
        uploaderAccountId: account.accountId,
        contentScope: 'private_message',
        state: 'deleting',
        bucket: 'komanda-media',
        objectKey: `media/${mediaId}.jpg`,
        sha256: Buffer.alloc(32),
        mime: 'image/jpeg',
        sizeBytes: 10,
        width: 1,
        height: 1,
        retentionClass: 'message_photo',
      },
    });
    await prisma.mediaBinding.create({
      data: {
        mediaId,
        ownerType: 'message',
        ownerId: crypto.randomUUID(),
        slot: 0,
        boundAt: new Date(),
      },
    });
    await prisma.mediaDeletionTombstone.create({
      data: {
        mediaId,
        bucket: 'komanda-media',
        objectKey: `media/${mediaId}.jpg`,
        state: 'in_progress',
        attemptCount: 1,
        availableAt: new Date(Date.now() - 60_000),
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    const worker = new FilesWorkerService(
      workerEnvironment,
      {
        createUploadUrl: async () => '',
        createDownloadUrl: async () => '',
        head: async () => undefined,
        get: async () => Buffer.alloc(0),
        put: async () => undefined,
        delete: async () => undefined,
      },
      { scan: async () => 'clean' as const },
      new JsonLogger('worker', 'silent'),
    );
    await worker.processPending();
    await worker.onApplicationShutdown();

    expect(await prisma.mediaObject.findUnique({ where: { id: mediaId } })).toBeNull();
    expect(await prisma.mediaBinding.findUnique({ where: { mediaId } })).toBeNull();
    expect(
      (await prisma.mediaDeletionTombstone.findUniqueOrThrow({ where: { mediaId } })).state,
    ).toBe('completed');
  });
});
