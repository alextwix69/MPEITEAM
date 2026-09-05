import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiApplication } from '../../src/api/app';
import { parseApiEnvironment, parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import type { DependencyProbe } from '../../src/platform/health/health.types';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { decryptSecret, sha256, randomSecret } from '../../src/platform/security/crypto';
import { purgeMainRegistrationState } from '../../src/worker/registration-retention';
import { IdentityService } from '../../src/modules/identity/application/identity.service';
import { RateLimitService } from '../../src/modules/identity/infrastructure/rate-limit.service';
import { OutboxWorkerService } from '../../src/worker/outbox-worker.service';
import { deliverPasswordReset, type EmailSender } from '../../src/modules/identity';
import { AppModule } from '../../src/app.module';
import { ProblemDetailsFilter } from '../../src/platform/http/problem-details';
import type { LegalEvidenceStore } from '../../src/modules/compliance';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2';

@Controller('protected-test')
class ProtectedTestController {
  @Get()
  read() {
    return { allowed: true };
  }
}
const environment = parseApiEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_PORT: '3001',
  API_DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  AUTH_TOKEN_ENCRYPTION_KEY: '1'.repeat(64),
  IDEMPOTENCY_HMAC_KEY: 'integration-idempotency-key-0000001',
  RATE_LIMIT_MAX_REQUESTS: '1000',
  SESSION_COOKIE_SECURE: 'true',
  TRUST_PROXY_HOPS: '1',
});

const probe: DependencyProbe = {
  checkPostgres: vi.fn(async () => 'up' as const),
  checkRedis: vi.fn(async () => 'up' as const),
  checkObjectStorage: vi.fn(async () => 'up' as const),
  checkWorkerHeartbeat: vi.fn(async () => 'up' as const),
  close: vi.fn(async () => undefined),
};

const validRegistration = {
  email: 'student@mpei.ru',
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
};

let application: INestApplication;
let http: ReturnType<typeof request>;
let prisma: PrismaClient;

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
  await prisma.outboxDelivery.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.resume.deleteMany();
  await prisma.profileVersion.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
});

afterAll(async () => {
  await Promise.all([application.close(), prisma.$disconnect()]);
});

function cookieFrom(response: request.Response): string {
  return (response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}

async function authAccount(active = true) {
  const registered = await http
    .post('/api/v1/auth/registrations')
    .set('Idempotency-Key', crypto.randomUUID())
    .send(validRegistration);
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const id = registered.body.accountId as string;
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: id, eventType: 'identity.email-verification.requested' },
  });
  const token = decryptSecret(
    environment.AUTH_TOKEN_ENCRYPTION_KEY,
    Buffer.from((event.payload as { encryptedToken: string }).encryptedToken, 'base64'),
  );
  if (active) {
    await prisma.outboxDelivery.updateMany({
      where: { consumer: 'compliance.consent-evidence' },
      data: { state: 'completed' },
    });
    const verified = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'verify-auth-fixture')
      .send({ token });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    return { id, token, cookie: cookieFrom(verified) };
  }
  const login = await http
    .post('/api/v1/auth/sessions')
    .send({ email: validRegistration.email, password: validRegistration.password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id, token, cookie: cookieFrom(login) };
}

async function resetToken(id: string) {
  const response = await http
    .post('/api/v1/auth/password-resets')
    .set('Idempotency-Key', 'request-reset')
    .send({ email: validRegistration.email });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: id, eventType: 'identity.password-reset.requested' },
  });
  return {
    event,
    token: decryptSecret(
      environment.AUTH_TOKEN_ENCRYPTION_KEY,
      Buffer.from((event.payload as { encryptedToken: string }).encryptedToken, 'base64'),
    ),
  };
}

describe('authentication lifecycle', () => {
  it('rotates sessions, issues stable CSRF, revokes only the current session and safely replays logout', async () => {
    const account = await authAccount();
    const login = await http
      .post('/api/v1/auth/sessions')
      .set('Cookie', account.cookie)
      .set('Idempotency-Key', 'login')
      .send({ email: validRegistration.email.toUpperCase(), password: validRegistration.password });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect((login.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /HttpOnly; Secure; SameSite=Lax/u,
    );
    expect((await http.get('/api/v1/me').set('Cookie', account.cookie)).status).toBe(401);
    const cookie = cookieFrom(login);
    const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', cookie);
    const second = await http.get('/api/v1/auth/csrf').set('Cookie', cookie);
    expect(csrf.body).toEqual(second.body);
    const another = await http
      .post('/api/v1/auth/sessions')
      .send({ email: validRegistration.email, password: validRegistration.password });
    const wrongCsrf = await http.get('/api/v1/auth/csrf').set('Cookie', cookieFrom(another));
    for (const origin of ['', 'null', 'https://attacker.invalid']) {
      const failed = await http
        .delete('/api/v1/auth/session')
        .set('Cookie', cookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf.body.csrfToken);
      expect(failed.status).toBe(403);
      expect(failed.body.error.code).toBe('CSRF_FAILED');
    }
    expect(
      (
        await http
          .delete('/api/v1/auth/session')
          .set('Cookie', cookie)
          .set('Origin', 'http://localhost:8080')
          .set('X-CSRF-Token', wrongCsrf.body.csrfToken)
      ).status,
    ).toBe(403);
    const logout = await http
      .delete('/api/v1/auth/session')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:8080')
      .set('X-CSRF-Token', csrf.body.csrfToken);
    expect(logout.status).toBe(204);
    expect(logout.text).toBe('');
    expect(
      (
        await http
          .delete('/api/v1/auth/session')
          .set('Cookie', cookie)
          .set('Origin', 'http://localhost:8080')
      ).status,
    ).toBe(204);
    expect(
      (await http.delete('/api/v1/auth/session').set('Origin', 'http://localhost:8080')).status,
    ).toBe(204);
    expect((await http.get('/api/v1/me').set('Cookie', cookieFrom(another))).status).toBe(200);
    const replay = await http
      .post('/api/v1/auth/sessions')
      .set('Idempotency-Key', 'login')
      .send({ email: validRegistration.email.toUpperCase(), password: validRegistration.password });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(cookieFrom(replay)).toBe(cookie);
    expect((await http.get('/api/v1/me').set('Cookie', cookieFrom(replay))).status).toBe(401);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).lastLoginAt,
    ).not.toBeNull();
  });

  it('changes password once, revokes all sessions across API instances and preserves account roots', async () => {
    const account = await authAccount();
    const secondApp = await createApiApplication(environment, {
      probe,
      logger: new JsonLogger('api', 'silent'),
    });
    await secondApp.init();
    try {
      const secondHttp = request(secondApp.getHttpServer());
      const other = await secondHttp
        .post('/api/v1/auth/sessions')
        .set('Idempotency-Key', 'before-reset')
        .send({ email: validRegistration.email, password: validRegistration.password });
      const reset = await resetToken(account.id);
      const input = { token: reset.token, password: 'new-very-long-password' };
      const results = await Promise.all(
        ['first', 'second'].map((key) =>
          http.post('/api/v1/auth/password-resets/confirm').set('Idempotency-Key', key).send(input),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([204, 401]);
      const successfulKey = results[0]!.status === 204 ? 'first' : 'second';
      const replay = await secondHttp
        .post('/api/v1/auth/password-resets/confirm')
        .set('Idempotency-Key', successfulKey)
        .send(input);
      expect(replay.status).toBe(204);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(
        (
          await http
            .post('/api/v1/auth/password-resets/confirm')
            .set('Idempotency-Key', successfulKey)
            .send({ ...input, password: 'changed-payload-password' })
        ).status,
      ).toBe(409);
      for (const cookie of [account.cookie, cookieFrom(other)])
        expect((await secondHttp.get('/api/v1/me').set('Cookie', cookie)).status).toBe(401);
      expect(
        (
          await http
            .post('/api/v1/auth/sessions')
            .send({ email: validRegistration.email, password: validRegistration.password })
        ).status,
      ).toBe(401);
      expect(
        (
          await secondHttp
            .post('/api/v1/auth/sessions')
            .send({ email: validRegistration.email, password: input.password })
        ).status,
      ).toBe(200);
      const verifyReplay = await http
        .post('/api/v1/auth/email-verifications')
        .set('Idempotency-Key', 'verify-auth-fixture')
        .send({ token: account.token });
      expect(verifyReplay.status).toBe(200);
      expect(
        (await secondHttp.get('/api/v1/me').set('Cookie', cookieFrom(verifyReplay))).status,
      ).toBe(401);
      expect(await prisma.profile.count()).toBe(1);
      expect(await prisma.resume.count()).toBe(1);
    } finally {
      await secondApp.close();
    }
  });

  it('allows only one of two distinct reset tokens to change the password', async () => {
    const account = await authAccount(false);
    const first = await resetToken(account.id);
    const second = randomSecret();
    // Covers legacy/overlapping issued tokens independently of request cooldown.
    await prisma.authToken.create({
      data: {
        id: crypto.randomUUID(),
        accountId: account.id,
        purpose: 'password_reset',
        tokenHash: new Uint8Array(sha256(second)),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const inputs = [first.token, second].map((token, index) => ({
      token,
      password: `replacement-password-${index}`,
    }));
    const results = await Promise.all(
      inputs.map((input, index) =>
        http
          .post('/api/v1/auth/password-resets/confirm')
          .set('Idempotency-Key', `distinct-token-${index}`)
          .send(input),
      ),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([204, 401]);
    const winner = results.findIndex(({ status }) => status === 204);
    const credential = await prisma.credential.findUniqueOrThrow({
      where: { accountId: account.id },
    });
    expect(await argon2.verify(credential.passwordHash, inputs[winner]!.password)).toBe(true);
    expect(
      await prisma.authToken.count({
        where: { accountId: account.id, purpose: 'password_reset', consumedAt: null },
      }),
    ).toBe(0);
    expect((await http.get('/api/v1/me').set('Cookie', account.cookie)).status).toBe(401);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).state).toBe(
      'unverified',
    );
  });

  it('does not reactivate a deleting account through email verification', async () => {
    const account = await authAccount(false);
    await prisma.account.update({ where: { id: account.id }, data: { state: 'deleting' } });
    const result = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'deleting-verification')
      .send({ token: account.token });
    expect(result.status).toBe(401);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).state).toBe(
      'deleting',
    );
    expect(await prisma.session.count()).toBe(1);
  });

  it('rejects purpose confusion, reuse and expired tokens without partial changes', async () => {
    const account = await authAccount(false);
    const reset = await resetToken(account.id);
    const verification = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'wrong-purpose')
      .send({ token: reset.token });
    expect(verification.status).toBe(401);
    const wrongReset = await http
      .post('/api/v1/auth/password-resets/confirm')
      .set('Idempotency-Key', 'wrong-reset')
      .send({ token: account.token, password: 'new-very-long-password' });
    expect(wrongReset.status).toBe(401);
    const reused = await http
      .post('/api/v1/auth/password-resets/confirm')
      .set('Idempotency-Key', 'reused')
      .send({ token: reset.token, password: validRegistration.password });
    expect(reused.body.error.code).toBe('PASSWORD_REUSED');
    expect((await http.get('/api/v1/me').set('Cookie', account.cookie)).status).toBe(200);
    await prisma.authToken.updateMany({
      where: { purpose: 'password_reset' },
      data: { expiresAt: new Date() },
    });
    expect(
      (
        await http
          .post('/api/v1/auth/password-resets/confirm')
          .set('Idempotency-Key', 'expired')
          .send({ token: reset.token, password: 'new-very-long-password' })
      ).status,
    ).toBe(401);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).state).toBe(
      'unverified',
    );
  });

  it('keeps reset requests generic, validates strict DTOs and deduplicates mail requests', async () => {
    const account = await authAccount();
    await resetToken(account.id);
    for (const email of [validRegistration.email, 'unknown@mpei.ru']) {
      const response = await http
        .post('/api/v1/auth/password-resets')
        .set('Idempotency-Key', `generic-${email === validRegistration.email}`)
        .send({ email });
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ accepted: true });
    }
    expect(
      await prisma.outboxEvent.count({ where: { eventType: 'identity.password-reset.requested' } }),
    ).toBe(1);
    expect(
      (
        await http
          .post('/api/v1/auth/password-resets')
          .set('Idempotency-Key', 'missing-email')
          .send({})
      ).status,
    ).toBe(422);
    expect(
      (
        await http.post('/api/v1/auth/sessions').send({
          email: validRegistration.email,
          password: validRegistration.password,
          admin: true,
        })
      ).status,
    ).toBe(422);
    const invalid = await http
      .post('/api/v1/auth/sessions')
      .send({ email: validRegistration.email, password: 'wrong' });
    const unknown = await http
      .post('/api/v1/auth/sessions')
      .send({ email: 'unknown@mpei.ru', password: 'wrong' });
    expect(invalid.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(invalid.body.error.code).toBe(unknown.body.error.code);
    expect(invalid.body.error.message).toBe(unknown.body.error.message);
    const replay = await http
      .post('/api/v1/auth/password-resets')
      .set('Idempotency-Key', 'request-reset')
      .send({ email: validRegistration.email });
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  it('enforces Active access through the global guard and limited state capabilities', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.register(probe, environment)],
      controllers: [ProtectedTestController],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter(new JsonLogger('api', 'silent')));
    await app.init();
    const client = request(app.getHttpServer());
    try {
      expect((await client.get('/protected-test')).status).toBe(401);
      const account = await authAccount(false);
      expect(
        (await client.get('/protected-test').set('Cookie', account.cookie)).body.error.code,
      ).toBe('ACCOUNT_UNVERIFIED');
      await prisma.account.update({
        where: { id: account.id },
        data: { state: 'active', emailVerifiedAt: new Date() },
      });
      expect((await client.get('/protected-test').set('Cookie', account.cookie)).status).toBe(200);
      await prisma.consentStatus.updateMany({
        where: { accountId: account.id, documentType: 'age_18' },
        data: { revokedAt: new Date() },
      });
      expect(
        (await client.get('/protected-test').set('Cookie', account.cookie)).body.error.code,
      ).toBe('CONSENT_REQUIRED');
      await prisma.account.update({ where: { id: account.id }, data: { state: 'deleting' } });
      expect(
        (await client.get('/protected-test').set('Cookie', account.cookie)).body.error.code,
      ).toBe('ACCOUNT_DELETING');
      expect(
        (await http.get('/api/v1/me').set('Cookie', account.cookie)).body.capabilities,
      ).toEqual([]);
      const login = await http
        .post('/api/v1/auth/sessions')
        .send({ email: validRegistration.email, password: validRegistration.password });
      expect(login.body.accountState).toBe('deleting');
      const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', cookieFrom(login));
      expect(
        (
          await http
            .delete('/api/v1/auth/session')
            .set('Cookie', cookieFrom(login))
            .set('Origin', 'http://localhost:8080')
            .set('X-CSRF-Token', csrf.body.csrfToken)
        ).status,
      ).toBe(204);
      await prisma.account.update({ where: { id: account.id }, data: { state: 'deleted' } });
      expect((await http.get('/api/v1/me').set('Cookie', account.cookie)).status).toBe(401);
      expect(
        (
          await http
            .post('/api/v1/auth/sessions')
            .send({ email: validRegistration.email, password: validRegistration.password })
        ).body.error.code,
      ).toBe('ACCOUNT_DELETED');
    } finally {
      await app.close();
    }
  });

  it('prevents a login verified before reset from committing a session afterwards', async () => {
    const account = await authAccount();
    const reset = await resetToken(account.id);
    const originalVerify = argon2.verify.bind(argon2);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(argon2, 'verify').mockImplementation(async (hash, password, options) => {
      const result = await originalVerify(hash, password, options);
      if (password === validRegistration.password) {
        entered();
        await barrier;
      }
      return result;
    });
    const login = http
      .post('/api/v1/auth/sessions')
      .send({ email: validRegistration.email, password: validRegistration.password })
      .then((response) => response);
    try {
      await checked;
      const response = await http
        .post('/api/v1/auth/password-resets/confirm')
        .set('Idempotency-Key', 'race-reset')
        .send({ token: reset.token, password: 'new-very-long-password' });
      expect(response.status).toBe(204);
      release();
      expect((await login).status).toBe(401);
    } finally {
      release();
      spy.mockRestore();
      await login;
    }
  });

  it('fails closed for new auth commands during limiter outage, but replays committed results', async () => {
    const account = await authAccount();
    const reset = await resetToken(account.id);
    const limiter = application.get(RateLimitService);
    const offline = new RateLimitService({
      ...environment,
      REDIS_URL: 'redis://127.0.0.1:1',
      DEPENDENCY_TIMEOUT_MS: 100,
    });
    const spy = vi
      .spyOn(limiter, 'consume')
      .mockImplementation((operation, subject) => offline.consume(operation, subject));
    try {
      const login = await http
        .post('/api/v1/auth/sessions')
        .send({ email: validRegistration.email, password: validRegistration.password });
      expect(login.status).toBe(503);
      expect(login.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
      const confirm = await http
        .post('/api/v1/auth/password-resets/confirm')
        .set('Idempotency-Key', 'outage-confirm')
        .send({ token: reset.token, password: 'new-very-long-password' });
      expect(confirm.status).toBe(503);
      const replay = await http
        .post('/api/v1/auth/password-resets')
        .set('Idempotency-Key', 'request-reset')
        .send({ email: validRegistration.email });
      expect(replay.status).toBe(202);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect((await http.get('/api/v1/me').set('Cookie', account.cookie)).status).toBe(200);
    } finally {
      spy.mockRestore();
      await offline.onApplicationShutdown();
    }
  });

  it('delivers reset mail via Identity and skips consumed or expired tokens', async () => {
    const account = await authAccount();
    const reset = await resetToken(account.id);
    const sender: EmailSender = {
      sendVerificationEmail: vi.fn(),
      sendPasswordResetEmail: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    await deliverPasswordReset(
      prisma,
      sender,
      environment.AUTH_TOKEN_ENCRYPTION_KEY,
      'http://localhost:8080',
      reset.event,
    );
    expect(sender.sendPasswordResetEmail).toHaveBeenCalledWith({
      eventId: reset.event.id,
      recipient: validRegistration.email,
      resetUrl: `http://localhost:8080/reset-password?token=${reset.token}`,
    });
    await prisma.authToken.updateMany({
      where: { purpose: 'password_reset' },
      data: { consumedAt: new Date() },
    });
    await deliverPasswordReset(
      prisma,
      sender,
      environment.AUTH_TOKEN_ENCRYPTION_KEY,
      'http://localhost:8080',
      reset.event,
    );
    expect(sender.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reset.event.payload)).not.toContain(reset.token);
  });

  it('upgrades legacy CSRF hashes and cleans only terminal sessions at retention boundary', async () => {
    const account = await authAccount();
    await prisma.session.updateMany({
      data: { csrfSecretHash: Uint8Array.from(sha256(randomSecret())) },
    });
    const csrf = await http.get('/api/v1/auth/csrf').set('Cookie', account.cookie);
    expect(csrf.status).toBe(200);
    expect(
      (
        await http
          .delete('/api/v1/auth/session')
          .set('Cookie', account.cookie)
          .set('Origin', 'http://localhost:8080')
          .set('X-CSRF-Token', csrf.body.csrfToken)
      ).status,
    ).toBe(204);
    const now = new Date();
    const old = new Date(now.getTime() - 31 * 86400_000);
    await prisma.session.updateMany({ data: { revokedAt: old } });
    const newLogin = await http
      .post('/api/v1/auth/sessions')
      .send({ email: validRegistration.email, password: validRegistration.password });
    await purgeMainRegistrationState(prisma, now);
    expect(await prisma.session.count()).toBe(1);
    expect((await http.get('/api/v1/me').set('Cookie', cookieFrom(newLogin))).status).toBe(200);
  });
});

describe('registration API', () => {
  it('atomically creates the account roots and replays the same result', async () => {
    const first = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'registration-replay')
      .send(validRegistration);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ accountState: 'unverified', verificationEmailQueued: true });

    const replay = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'registration-replay')
      .send(validRegistration);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    await expect(prisma.account.count()).resolves.toBe(1);
    await expect(prisma.consentStatus.count()).resolves.toBe(4);
    await expect(prisma.profile.count()).resolves.toBe(1);
    await expect(prisma.profileVersion.count()).resolves.toBe(1);
    await expect(prisma.resume.count()).resolves.toBe(1);
    await expect(prisma.outboxDelivery.count()).resolves.toBe(5);
  });

  it('replays a completed registration even when the rate limiter is unavailable', async () => {
    const first = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'registration-replay-without-redis')
      .send(validRegistration);
    expect(first.status).toBe(201);

    const rateLimit = application.get(RateLimitService);
    const unavailable = vi.spyOn(rateLimit, 'consume').mockRejectedValue(new Error('redis down'));
    try {
      const replay = await http
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-replay-without-redis')
        .send(validRegistration);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
    } finally {
      unavailable.mockRestore();
    }
  });

  it('uses the trusted proxy address instead of an attacker-supplied leftmost address', async () => {
    const identity = application.get(IdentityService);
    const register = vi.spyOn(identity, 'register').mockResolvedValue({
      body: {
        accountId: '0198a8e7-5132-7c8b-a566-0242ac120002',
        accountState: 'unverified',
        verificationEmailQueued: true,
      },
      replayed: false,
    });
    try {
      const response = await http
        .post('/api/v1/auth/registrations')
        .set('X-Forwarded-For', '198.51.100.100, 203.0.113.10')
        .set('Idempotency-Key', 'proxy-address')
        .send(validRegistration);
      expect(response.status).toBe(201);
      expect(register.mock.calls[0]?.[2]).toBe('203.0.113.10');
    } finally {
      register.mockRestore();
    }
  });

  it('returns the documented RATE_LIMITED code and retry metadata', async () => {
    const limiter = new RateLimitService({ ...environment, RATE_LIMIT_MAX_REQUESTS: 1 });
    const subject = crypto.randomUUID();
    try {
      await limiter.consume('contract-test', subject);
      await expect(limiter.consume('contract-test', subject)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        status: 429,
        retryable: true,
      });
    } finally {
      await limiter.onApplicationShutdown();
    }
  });

  it('starts with Redis unavailable without consuming delivery attempts', async () => {
    await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'worker-redis-outage-registration')
      .send(validRegistration);
    const workerEnvironment = parseWorkerEnvironment({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: 'redis://127.0.0.1:1',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'komanda-media',
      S3_ACCESS_KEY: 'local',
      S3_SECRET_KEY: 'local-secret',
      DEPENDENCY_TIMEOUT_MS: '100',
      OUTBOX_POLL_INTERVAL_MS: '60000',
      WORKER_DATABASE_URL: databaseUrl,
      LEGAL_DATABASE_URL:
        process.env.TEST_LEGAL_DATABASE_URL ??
        'postgresql://komanda_legal:komanda-legal-local@127.0.0.1:55432/komanda_legal_test?connection_limit=2',
    });
    const emailSender = {
      sendVerificationEmail: vi.fn(async () => undefined),
      sendPasswordResetEmail: vi.fn(async () => undefined),
      close: vi.fn(),
    } satisfies EmailSender;
    const legalEvidence = {
      appendConsentEvidence: vi.fn(async () => undefined),
      purgeExpired: vi.fn(async () => 0),
    } as unknown as LegalEvidenceStore;
    const worker = new OutboxWorkerService(
      workerEnvironment,
      new JsonLogger('worker', 'silent'),
      emailSender,
      legalEvidence,
    );
    const startedAt = performance.now();
    try {
      await worker.onApplicationBootstrap();
      expect(performance.now() - startedAt).toBeLessThan(3000);
      await expect(prisma.outboxDelivery.count({ where: { state: 'pending' } })).resolves.toBe(5);
      await expect(
        prisma.outboxDelivery.count({ where: { attemptCount: { gt: 0 } } }),
      ).resolves.toBe(0);
    } finally {
      await worker.onApplicationShutdown();
    }
  });

  it.each([
    {
      formalRole: 'teacher',
      email: 'teacher@mpei.ru',
      profile: {
        fullName: 'Анна Петрова',
        specialization: 'Электроэнергетика',
        timezone: 'Europe/Moscow',
        department: 'Кафедра РЗиАЭ',
      },
    },
    {
      formalRole: 'employer',
      email: 'employer@example.org',
      profile: {
        fullName: 'Сергей Волков',
        specialization: 'Подбор инженеров',
        timezone: 'Europe/Moscow',
        company: 'ЭнергоПроект',
        position: 'Руководитель отдела',
      },
    },
  ])('creates the initial roots for $formalRole', async ({ email, formalRole, profile }) => {
    const response = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', `registration-${formalRole}`)
      .send({ ...validRegistration, email, formalRole, profile });

    expect(response.status).toBe(201);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: response.body.accountId },
    });
    const version = await prisma.profileVersion.findFirstOrThrow({
      where: { profile: { accountId: account.id } },
    });
    expect(account.formalRole).toBe(formalRole);
    expect(version.fullName).toBe(profile.fullName);
    await expect(prisma.consentStatus.count({ where: { accountId: account.id } })).resolves.toBe(4);
    await expect(
      prisma.resume.count({ where: { profile: { accountId: account.id } } }),
    ).resolves.toBe(1);
  });

  it('rejects invalid domain and missing consent without partial data', async () => {
    const domain = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'invalid-domain')
      .send({ ...validRegistration, email: 'student@mpei.ru.evil' });
    expect(domain.status).toBe(422);
    expect(domain.body.error.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');

    const consents = structuredClone(validRegistration);
    consents.consents[0]!.accepted = false;
    const missing = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'missing-consent')
      .send(consents);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('AGE_CONFIRMATION_REQUIRED');
    await expect(prisma.account.count()).resolves.toBe(0);
  });

  it('activates only after all legal deliveries and returns an opaque session', async () => {
    const registered = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'verification-registration')
      .send(validRegistration);
    const emailEvent = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'identity.email-verification.requested' },
    });
    const payload = emailEvent.payload as { encryptedToken: string };
    const token = decryptSecret(
      environment.AUTH_TOKEN_ENCRYPTION_KEY,
      Buffer.from(payload.encryptedToken, 'base64'),
    );

    const waiting = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'verification')
      .send({ token });
    expect(waiting.status).toBe(503);
    expect(waiting.body.error.code).toBe('CONSENT_EVIDENCE_UNAVAILABLE');

    await prisma.outboxDelivery.updateMany({
      where: { consumer: 'compliance.consent-evidence' },
      data: { state: 'completed', completedAt: new Date() },
    });
    const verified = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'verification')
      .send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      accountId: registered.body.accountId,
      accountState: 'active',
    });
    const setCookie = verified.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toContain('__Host-session=');
    expect(setCookie[0]).toContain('HttpOnly');
    expect(setCookie[0]).toContain('Secure');
    const cookie = setCookie[0]!.split(';')[0]!;

    const me = await http.get('/api/v1/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.body).toMatchObject({
      id: registered.body.accountId,
      state: 'active',
      emailVerified: true,
    });
    expect(JSON.stringify(me.body)).not.toContain('student@mpei.ru');

    const replay = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'verification')
      .send({ token });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    await expect(prisma.session.count()).resolves.toBe(1);
  });

  it('returns the same generic resend response for unknown and known emails', async () => {
    await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'resend-registration')
      .send(validRegistration);
    const known = await http
      .post('/api/v1/auth/email-verifications/resend')
      .set('Idempotency-Key', 'known-resend')
      .send({ email: validRegistration.email });
    const unknown = await http
      .post('/api/v1/auth/email-verifications/resend')
      .set('Idempotency-Key', 'unknown-resend')
      .send({ email: 'unknown@mpei.ru' });
    expect(known.status, JSON.stringify(known.body)).toBe(202);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(202);
    expect(known.body).toEqual({ accepted: true });
    expect(unknown.body).toEqual(known.body);
  });

  it('serializes concurrent resend requests and creates only one replacement token', async () => {
    const registered = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'concurrent-resend-registration')
      .send(validRegistration);
    await prisma.authToken.updateMany({
      where: { accountId: registered.body.accountId },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });

    const [left, right] = await Promise.all([
      http
        .post('/api/v1/auth/email-verifications/resend')
        .set('Idempotency-Key', 'concurrent-resend-left')
        .send({ email: validRegistration.email }),
      http
        .post('/api/v1/auth/email-verifications/resend')
        .set('Idempotency-Key', 'concurrent-resend-right')
        .send({ email: validRegistration.email }),
    ]);
    expect([left.status, right.status]).toEqual([202, 202]);
    await expect(
      prisma.outboxEvent.count({
        where: {
          aggregateId: registered.body.accountId,
          eventType: 'identity.email-verification.requested',
        },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.authToken.count({
        where: { accountId: registered.body.accountId, consumedAt: null },
      }),
    ).resolves.toBe(1);
  });

  it('returns the documented authentication status for an invalid token', async () => {
    const response = await http
      .post('/api/v1/auth/email-verifications')
      .set('Idempotency-Key', 'invalid-token-status')
      .send({ token: 'x'.repeat(32) });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_INVALID_OR_EXPIRED');
  });

  it('purges only terminal registration records after their retention deadline', async () => {
    const registered = await http
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', 'retention-registration')
      .send(validRegistration);
    const now = new Date('2026-09-04T12:00:00.000Z');
    const old = new Date('2026-07-01T00:00:00.000Z');
    const accountId = registered.body.accountId as string;
    const terminalToken = await prisma.authToken.findFirstOrThrow({ where: { accountId } });
    await prisma.authToken.update({ where: { id: terminalToken.id }, data: { consumedAt: old } });
    const activeToken = await prisma.authToken.create({
      data: {
        id: crypto.randomUUID(),
        accountId,
        purpose: 'email_verification',
        tokenHash: Uint8Array.from(Buffer.alloc(32, 7)),
        expiresAt: new Date('2026-09-05T12:00:00.000Z'),
      },
    });
    await prisma.idempotencyRecord.updateMany({
      where: { responseRefId: accountId },
      data: { expiresAt: old },
    });
    const completedEvent = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: accountId, eventType: 'identity.email-verification.requested' },
    });
    await prisma.outboxEvent.updateMany({
      where: { aggregateId: accountId },
      data: { occurredAt: old },
    });
    await prisma.outboxDelivery.updateMany({
      where: { eventId: completedEvent.id },
      data: { state: 'completed', completedAt: old },
    });

    await purgeMainRegistrationState(prisma, now);

    await expect(
      prisma.authToken.findUnique({ where: { id: terminalToken.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.authToken.findUnique({ where: { id: activeToken.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.idempotencyRecord.count({ where: { responseRefId: accountId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.outboxEvent.findUnique({ where: { id: completedEvent.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.outboxDelivery.count({
        where: { event: { aggregateId: accountId }, state: 'pending' },
      }),
    ).resolves.toBe(4);
  });
});
