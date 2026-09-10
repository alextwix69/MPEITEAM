import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiApplication } from '../../src/api/app';
import { FilesService } from '../../src/modules/files';
import { NotificationsService } from '../../src/modules/notifications';
import { ProfilesService } from '../../src/modules/profiles';
import { TrustService, type ContentModerator } from '../../src/modules/trust';
import { parseApiEnvironment, parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import { DatabaseService } from '../../src/platform/database/database.service';
import type { DependencyProbe } from '../../src/platform/health/health.types';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { decryptSecret } from '../../src/platform/security/crypto';
import { ModerationWorkerService } from '../../src/worker/moderation-worker.service';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=3';
const apiEnvironment = parseApiEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  AUTH_TOKEN_ENCRYPTION_KEY: '1'.repeat(64),
  IDEMPOTENCY_HMAC_KEY: 'profiles-integration-idempotency-key-001',
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
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  AUTH_TOKEN_ENCRYPTION_KEY: '1'.repeat(64),
  LEGAL_SUBJECT_HMAC_KEY: 'profiles-integration-legal-key-0001',
  PUBLIC_APP_URL: 'http://localhost:8080',
});
const probe: DependencyProbe = {
  checkPostgres: vi.fn(async () => 'up' as const),
  checkRedis: vi.fn(async () => 'up' as const),
  checkObjectStorage: vi.fn(async () => 'up' as const),
  checkWorkerHeartbeat: vi.fn(async () => 'up' as const),
  close: vi.fn(async () => undefined),
};

let application: INestApplication;
let http: ReturnType<typeof request>;
let prisma: PrismaClient;

function cookieFrom(response: request.Response): string {
  return (response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}

async function createActiveAccount(email: string) {
  const registered = await http
    .post('/api/v1/auth/registrations')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({
      email,
      password: 'very-long-password',
      formalRole: 'student',
      profile: {
        fullName: 'Иван Иванов',
        specialization: 'Энергетика',
        timezone: 'Europe/Moscow',
        institute: 'ИЭТ',
        course: 2,
      },
      consents: [
        { documentType: 'age_18', documentVersion: 'local-v1', accepted: true },
        { documentType: 'user_terms', documentVersion: 'local-v1', accepted: true },
        { documentType: 'personal_data', documentVersion: 'local-v1', accepted: true },
        {
          documentType: 'public_profile_distribution',
          documentVersion: 'local-v1',
          accepted: true,
        },
      ],
    });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const accountId = registered.body.accountId as string;
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: accountId, eventType: 'identity.email-verification.requested' },
  });
  const token = decryptSecret(
    apiEnvironment.AUTH_TOKEN_ENCRYPTION_KEY,
    Buffer.from((event.payload as { encryptedToken: string }).encryptedToken, 'base64'),
  );
  await prisma.outboxDelivery.updateMany({
    where: { event: { actorAccountId: accountId }, consumer: 'compliance.consent-evidence' },
    data: { state: 'completed' },
  });
  const verified = await http
    .post('/api/v1/auth/email-verifications')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ token });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', cookieFrom(verified));
  return { accountId, cookie: cookieFrom(verified), csrf: csrf.body.csrfToken as string };
}

async function processModeration(): Promise<void> {
  const database = application.get(DatabaseService);
  const trust = new TrustService(database, workerEnvironment);
  const requested = await prisma.outboxEvent.findMany({
    where: {
      eventType: 'profiles.moderation.requested',
      deliveries: { some: { consumer: 'trust.automated-moderation', state: 'pending' } },
    },
  });
  for (const event of requested) {
    await trust.consumeModerationRequest(event);
    await prisma.outboxDelivery.updateMany({
      where: { eventId: event.id, consumer: 'trust.automated-moderation' },
      data: { state: 'completed' },
    });
  }
  const moderator: ContentModerator = {
    moderate: async (_endpoint, input) =>
      input.text.includes('[[reject:profanity]]')
        ? {
            approved: false,
            violationCodes: ['profanity'],
            reason: 'Удалите запрещённый фрагмент и отправьте материал повторно.',
          }
        : { approved: true, violationCodes: [] },
  };
  const worker = new ModerationWorkerService(
    workerEnvironment,
    new JsonLogger('worker', 'silent'),
    trust,
    application.get(ProfilesService),
    application.get(FilesService),
    moderator,
  );
  await worker.onApplicationBootstrap();
  await worker.onApplicationShutdown();

  const notifications = application.get(NotificationsService);
  const decided = await prisma.outboxEvent.findMany({
    where: {
      eventType: 'profiles.moderation.decided',
      deliveries: { some: { consumer: 'notifications.moderation-result', state: 'pending' } },
    },
  });
  for (const event of decided) {
    await notifications.consumeModerationResult(event);
    await prisma.outboxDelivery.updateMany({
      where: { eventId: event.id, consumer: 'notifications.moderation-result' },
      data: { state: 'completed' },
    });
  }
}

describe('profile, primary resume, catalog and notification API', () => {
  beforeAll(async () => {
    application = await createApiApplication(apiEnvironment, {
      probe,
      logger: new JsonLogger('api', 'silent'),
    });
    await application.init();
    http = request(application.getHttpServer());
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  beforeEach(async () => {
    await prisma.emailDelivery.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.notificationsInboxEvent.deleteMany();
    await prisma.moderationDecision.deleteMany();
    await prisma.moderationRequest.deleteMany();
    await prisma.trustInboxEvent.deleteMany();
    await prisma.profilesInboxEvent.deleteMany();
    await prisma.mediaBinding.deleteMany();
    await prisma.mediaObject.deleteMany();
    await prisma.uploadSession.deleteMany();
    await prisma.outboxDelivery.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.resume.deleteMany();
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

  it('publishes moderated profile and primary resume while preserving the last approved version', async () => {
    const owner = await createActiveAccount('profile-owner@mpei.ru');
    const viewer = await createActiveAccount('profile-viewer@mpei.ru');
    const ownProfile = await http.get('/api/v1/me/profile').set('Cookie', owner.cookie);
    expect(ownProfile.status).toBe(200);
    expect(ownProfile.body.pending.fullName).toBe('Иван Иванов');
    expect(ownProfile.headers.etag).toBe(`"${ownProfile.body.rowVersion}"`);

    const catalog = await http.get('/api/v1/catalog/tags').set('Cookie', owner.cookie);
    expect(catalog.status).toBe(200);
    expect(catalog.body.items).toHaveLength(180);
    expect(catalog.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/u);

    const category = catalog.body.items[0].category as string;
    const filteredCatalog = await http
      .get('/api/v1/catalog/tags')
      .query({ category })
      .set('Cookie', owner.cookie);
    expect(filteredCatalog.status).toBe(200);
    expect(filteredCatalog.body.items.length).toBeGreaterThan(0);
    expect(
      filteredCatalog.body.items.every((tag: { category: string }) => tag.category === category),
    ).toBe(true);
    expect(filteredCatalog.headers.etag).not.toBe(catalog.headers.etag);
    const unchangedCategory = await http
      .get('/api/v1/catalog/tags')
      .query({ category })
      .set('Cookie', owner.cookie)
      .set('If-None-Match', String(filteredCatalog.headers.etag));
    expect(unchangedCategory.status).toBe(304);

    const resumes = await http.get('/api/v1/me/resumes').set('Cookie', owner.cookie);
    expect(resumes.status).toBe(200);
    expect(resumes.body.items).toHaveLength(1);
    const primary = resumes.body.items[0];
    expect(primary).toMatchObject({ slot: 0, primary: true, searchVisible: true });
    expect(
      (await http.get(`/api/v1/me/resumes/${primary.id}`).set('Cookie', owner.cookie)).status,
    ).toBe(200);

    const key = crypto.randomUUID();
    const updateProfile = () =>
      http
        .patch('/api/v1/me/profile')
        .set('Cookie', owner.cookie)
        .set('Origin', 'http://localhost:8080')
        .set('X-CSRF-Token', owner.csrf)
        .set('Idempotency-Key', key)
        .set('If-Match', String(ownProfile.headers.etag))
        .send({
          fullName: 'Иван Петров',
          specialization: 'Энергетика',
          timezone: 'Europe/Moscow',
          institute: 'ИЭТ',
          course: 3,
        });
    const updated = await updateProfile();
    expect(updated.status, JSON.stringify(updated.body)).toBe(202);
    expect(updated.body.moderation.state).toBe('pending');
    const replay = await updateProfile();
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(
      (await http.get(`/api/v1/profiles/${owner.accountId}`).set('Cookie', viewer.cookie)).status,
    ).toBe(404);

    await processModeration();
    const publicProfile = await http
      .get(`/api/v1/profiles/${owner.accountId}`)
      .set('Cookie', viewer.cookie);
    expect(publicProfile.status).toBe(200);
    expect(publicProfile.body.profile.fullName).toBe('Иван Петров');
    expect(publicProfile.body).not.toHaveProperty('email');
    expect(publicProfile.body.resumes).toEqual([]);

    const freshResume = await http
      .get(`/api/v1/me/resumes/${primary.id}`)
      .set('Cookie', owner.cookie);
    const updatedResume = await http
      .patch(`/api/v1/me/resumes/${primary.id}`)
      .set('Cookie', owner.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', String(freshResume.headers.etag))
      .send({
        about: 'Проектирую энергетические системы',
        projects: [{ title: 'Стенд', description: 'Учебный стенд' }],
        tagIds: [catalog.body.items[0].id],
        searchVisible: true,
      });
    expect(updatedResume.status, JSON.stringify(updatedResume.body)).toBe(202);
    await processModeration();
    const withResume = await http
      .get(`/api/v1/profiles/${owner.accountId}`)
      .set('Cookie', viewer.cookie);
    expect(withResume.body.resumes).toHaveLength(1);
    expect(withResume.body.resumes[0].tagIds).toEqual([catalog.body.items[0].id]);

    const freshProfile = await http.get('/api/v1/me/profile').set('Cookie', owner.cookie);
    const rejected = await http
      .patch('/api/v1/me/profile')
      .set('Cookie', owner.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', String(freshProfile.headers.etag))
      .send({
        ...freshProfile.body.published,
        specialization: '[[reject:profanity]]',
      });
    expect(rejected.status).toBe(202);
    await processModeration();
    const ownerAfterReject = await http.get('/api/v1/me/profile').set('Cookie', owner.cookie);
    expect(ownerAfterReject.body.moderation).toMatchObject({
      state: 'revision_required',
      violationCodes: ['profanity'],
    });
    expect(ownerAfterReject.body.pending.specialization).toBe('[[reject:profanity]]');
    const stillPublic = await http
      .get(`/api/v1/profiles/${owner.accountId}`)
      .set('Cookie', viewer.cookie);
    expect(stillPublic.body.profile.specialization).toBe('Энергетика');

    const notifications = await http.get('/api/v1/notifications').set('Cookie', owner.cookie);
    expect(notifications.status).toBe(200);
    expect(notifications.body.items).toHaveLength(3);
    expect(notifications.body.page.nextCursor).toBeNull();
    expect(await prisma.emailDelivery.count()).toBe(3);
    const first = notifications.body.items[0];
    const read = await http
      .patch(`/api/v1/notifications/${first.id}`)
      .set('Cookie', owner.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', owner.csrf)
      .set('If-Match', `"${first.rowVersion}"`)
      .send({ read: true });
    expect(read.status).toBe(200);
    expect(read.body.read).toBe(true);
    const readAll = await http
      .post('/api/v1/notifications/read-all')
      .set('Cookie', owner.cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ before: new Date().toISOString() });
    expect(readAll.status).toBe(200);
    expect(readAll.body.updatedCount).toBe(2);

    const readAllKey = crypto.randomUUID();
    const readAllWithoutTimestamp = () =>
      http
        .post('/api/v1/notifications/read-all')
        .set('Cookie', owner.cookie)
        .set('Origin', 'http://localhost:8080')
        .set('X-CSRF-Token', owner.csrf)
        .set('Idempotency-Key', readAllKey)
        .send({});
    expect((await readAllWithoutTimestamp()).status).toBe(200);
    const readAllReplay = await readAllWithoutTimestamp();
    expect(readAllReplay.status).toBe(200);
    expect(readAllReplay.headers['idempotency-replayed']).toBe('true');
  });
});
