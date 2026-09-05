import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import type { ApiEnvironment } from '../../../platform/config/env.schema';
import { DatabaseService } from '../../../platform/database/database.service';
import { ApplicationError } from '../../../platform/http/application-error';
import { getRequestContext } from '../../../platform/http/request-context';
import {
  canonicalJson,
  decryptSecret,
  encryptSecret,
  hmacSha256,
  randomSecret,
  sha256,
} from '../../../platform/security/crypto';
import { ProfilesService } from '../../profiles';
import type {
  EmailRequest,
  RegistrationRequest,
  LoginRequest,
  PasswordResetConfirm,
} from '../identity.schemas';
import { IDENTITY_ENVIRONMENT } from '../identity.tokens';
import {
  consentDocumentTypes,
  type CommandResult,
  type ConsentDocumentType,
  type CurrentAccount,
  type RegistrationResult,
  type SessionView,
} from '../identity.types';
import { RateLimitService } from '../infrastructure/rate-limit.service';

const ARGON2_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_CONSUMER = 'identity.verification-email';
const LEGAL_CONSUMER = 'compliance.consent-evidence';
const authCounter = metrics
  .getMeter('komanda-mpei-identity')
  .createCounter('identity.auth.commands');
const csrfCounter = metrics
  .getMeter('komanda-mpei-identity')
  .createCounter('identity.csrf.failures');
// Constant-cost verification for an unknown account, without a reusable credential.
const dummyPasswordHash = argon2.hash(randomSecret(), ARGON2_PARAMETERS);
const verificationAge = metrics
  .getMeter('komanda-mpei-identity')
  .createHistogram('identity.email_verification.age', { unit: 'ms' });

interface IdempotencyScope {
  actorAccountId?: string;
  publicSubjectHash?: Buffer;
}

interface IdempotencyReservation {
  id: string;
  replay?: {
    status: number;
    body: unknown;
    secret?: Uint8Array;
  };
}

interface StoredIdempotencyRecord {
  id: string;
  requestHash: Uint8Array;
  state: string;
  responseStatus: number | null;
  responseBody: Prisma.JsonValue | null;
  responseSecret: Uint8Array | null;
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().normalize('NFKC').toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator < 1) return normalized;
  const local = normalized.slice(0, separator);
  const domain = domainToASCII(normalized.slice(separator + 1));
  return `${local}@${domain}`;
}

function bufferEquals(left: Uint8Array, right: Buffer): boolean {
  return Buffer.from(left).equals(right);
}

function databaseBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(ProfilesService)
    private readonly profiles: ProfilesService,
    @Inject(RateLimitService)
    private readonly rateLimit: RateLimitService,
    @Inject(IDENTITY_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  currentConsentVersions(): Record<ConsentDocumentType, string> {
    return {
      age_18: this.environment.CONSENT_VERSION_AGE_18,
      user_terms: this.environment.CONSENT_VERSION_USER_TERMS,
      personal_data: this.environment.CONSENT_VERSION_PERSONAL_DATA,
      public_profile_distribution: this.environment.CONSENT_VERSION_PUBLIC_PROFILE,
    };
  }

  validateRegistrationRules(request: RegistrationRequest): string {
    const email = normalizeEmail(request.email);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (request.formalRole !== 'employer' && domain !== 'mpei.ru') {
      throw new ApplicationError(
        'EMAIL_DOMAIN_NOT_ALLOWED',
        'Для студента или преподавателя используйте адрес в домене @mpei.ru.',
        422,
      );
    }

    const byType = new Map(request.consents.map((consent) => [consent.documentType, consent]));
    const age = byType.get('age_18');
    if (!age?.accepted) {
      throw new ApplicationError(
        'AGE_CONFIRMATION_REQUIRED',
        'Подтвердите, что вам исполнилось 18 лет.',
        422,
      );
    }
    if (
      byType.size !== consentDocumentTypes.length ||
      consentDocumentTypes.some((type) => !byType.get(type)?.accepted)
    ) {
      throw new ApplicationError(
        'CONSENT_REQUIRED',
        'Примите каждое обязательное согласие отдельно, чтобы продолжить.',
        422,
      );
    }
    const currentVersions = this.currentConsentVersions();
    const outdated = consentDocumentTypes.some(
      (type) => byType.get(type)?.documentVersion !== currentVersions[type],
    );
    if (outdated) {
      throw new ApplicationError(
        'CONSENT_VERSION_OUTDATED',
        'Документы обновились. Ознакомьтесь с актуальными версиями и подтвердите согласия снова.',
        409,
      );
    }
    return email;
  }

  async register(
    request: RegistrationRequest,
    idempotencyKey: string,
    ipAddress: string,
  ): Promise<CommandResult<RegistrationResult>> {
    const email = this.validateRegistrationRules(request);
    const requestHash = sha256(canonicalJson(request));
    const publicSubjectHash = hmacSha256(this.environment.IDEMPOTENCY_HMAC_KEY, email);
    const replay = await this.lookupIdempotency(
      { publicSubjectHash },
      'POST /auth/registrations',
      idempotencyKey,
      requestHash,
    );
    if (replay?.replay) {
      return { body: replay.replay.body as RegistrationResult, replayed: true };
    }
    await Promise.all([
      this.rateLimit.consume('register-ip', ipAddress),
      this.rateLimit.consume('register-email', email),
    ]);

    const accountId = uuidv7();
    const now = new Date();
    const rawToken = randomSecret();
    const encryptedToken = encryptSecret(this.environment.AUTH_TOKEN_ENCRYPTION_KEY, rawToken);
    const result: RegistrationResult = {
      accountId,
      accountState: 'unverified',
      verificationEmailQueued: true,
    };
    const passwordHash = await argon2.hash(request.password, ARGON2_PARAMETERS);

    try {
      return await this.database.$transaction(async (transaction) => {
        const reservation = await this.reserveIdempotency(
          transaction,
          { publicSubjectHash },
          'POST /auth/registrations',
          idempotencyKey,
          requestHash,
        );
        if (reservation.replay) {
          return {
            body: reservation.replay.body as RegistrationResult,
            replayed: true,
          };
        }

        await transaction.account.create({
          data: {
            id: accountId,
            emailNormalized: email,
            formalRole: request.formalRole,
            credential: {
              create: {
                passwordHash,
                argon2Parameters: {
                  version: 1,
                  algorithm: 'argon2id',
                  memoryCost: ARGON2_PARAMETERS.memoryCost,
                  timeCost: ARGON2_PARAMETERS.timeCost,
                  parallelism: ARGON2_PARAMETERS.parallelism,
                  hashLength: ARGON2_PARAMETERS.hashLength,
                },
                passwordChangedAt: now,
              },
            },
          },
        });
        await this.profiles.createInitialProfile(
          transaction,
          accountId,
          request.formalRole,
          request.profile,
        );

        const consents = new Map(
          request.consents.map((consent) => [consent.documentType, consent]),
        );
        for (const documentType of consentDocumentTypes) {
          const consent = consents.get(documentType)!;
          const eventId = uuidv7();
          await transaction.consentStatus.create({
            data: {
              accountId,
              documentType,
              documentVersion: consent.documentVersion,
              acceptedAt: now,
              sourceEventId: eventId,
            },
          });
          await this.createOutboxEvent(transaction, {
            eventId,
            eventType: 'identity.consent.accepted',
            accountId,
            occurredAt: now,
            payload: {
              documentType,
              documentVersion: consent.documentVersion,
              occurredAt: now.toISOString(),
            },
            consumers: [LEGAL_CONSUMER],
          });
        }

        const emailEventId = uuidv7();
        await transaction.authToken.create({
          data: {
            id: uuidv7(),
            accountId,
            purpose: 'email_verification',
            tokenHash: databaseBytes(sha256(rawToken)),
            expiresAt: new Date(now.getTime() + this.environment.AUTH_TOKEN_TTL_SECONDS * 1000),
          },
        });
        await this.createOutboxEvent(transaction, {
          eventId: emailEventId,
          eventType: 'identity.email-verification.requested',
          accountId,
          occurredAt: now,
          payload: {
            encryptedToken: encryptedToken.toString('base64'),
          },
          consumers: [EMAIL_CONSUMER],
        });
        await this.completeIdempotency(transaction, reservation.id, 201, result, accountId);
        return { body: result, replayed: false };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApplicationError(
          'EMAIL_ALREADY_REGISTERED',
          'Аккаунт с таким адресом уже существует. Используйте вход или восстановление доступа.',
          409,
        );
      }
      throw error;
    }
  }

  async verifyEmail(
    rawToken: string,
    idempotencyKey: string,
    ipAddress: string,
    previousSession?: string,
  ): Promise<CommandResult<SessionView>> {
    const tokenHash = sha256(rawToken);
    const token = await this.database.authToken.findUnique({
      where: { tokenHash: databaseBytes(tokenHash) },
    });
    if (!token || token.purpose !== 'email_verification') this.invalidToken();
    verificationAge.record(Math.max(0, Date.now() - token.createdAt.getTime()));

    const requestHash = sha256(canonicalJson({ token: rawToken }));
    const replay = await this.lookupIdempotency(
      { actorAccountId: token.accountId },
      'POST /auth/email-verifications',
      idempotencyKey,
      requestHash,
    );
    if (replay?.replay) {
      if (!replay.replay.secret) throw new Error('IDEMPOTENCY_SECRET_MISSING');
      return {
        body: replay.replay.body as SessionView,
        replayed: true,
        sessionSecret: decryptSecret(
          this.environment.AUTH_TOKEN_ENCRYPTION_KEY,
          replay.replay.secret,
        ),
      };
    }
    await this.rateLimit.consume('verify', `${ipAddress}:${tokenHash.toString('hex')}`);
    return this.database.$transaction(async (transaction) => {
      const reservation = await this.reserveIdempotency(
        transaction,
        { actorAccountId: token.accountId },
        'POST /auth/email-verifications',
        idempotencyKey,
        requestHash,
      );
      if (reservation.replay) {
        if (!reservation.replay.secret) throw new Error('IDEMPOTENCY_SECRET_MISSING');
        return {
          body: reservation.replay.body as SessionView,
          replayed: true,
          sessionSecret: decryptSecret(
            this.environment.AUTH_TOKEN_ENCRYPTION_KEY,
            reservation.replay.secret,
          ),
        };
      }

      await this.lockAccount(transaction, token.accountId);
      const currentAccount = await transaction.account.findUnique({
        where: { id: token.accountId },
      });
      if (currentAccount?.state !== 'unverified') this.invalidToken();
      const freshToken = await transaction.authToken.findUnique({ where: { id: token.id } });
      if (!freshToken || freshToken.consumedAt || freshToken.expiresAt <= new Date()) {
        this.invalidToken();
      }
      const consents = await transaction.consentStatus.findMany({
        where: { accountId: token.accountId, acceptedAt: { not: null }, revokedAt: null },
      });
      if (consents.length !== consentDocumentTypes.length) {
        throw new ApplicationError(
          'CONSENT_EVIDENCE_UNAVAILABLE',
          'Подтверждение согласий ещё не завершено. Повторите попытку позже.',
          503,
          true,
          undefined,
          undefined,
          2,
        );
      }
      const completedProofs = await transaction.outboxDelivery.count({
        where: {
          eventId: { in: consents.map(({ sourceEventId }) => sourceEventId) },
          consumer: LEGAL_CONSUMER,
          state: 'completed',
        },
      });
      if (completedProofs !== consentDocumentTypes.length) {
        throw new ApplicationError(
          'CONSENT_EVIDENCE_UNAVAILABLE',
          'Подтверждение согласий ещё не завершено. Повторите попытку позже.',
          503,
          true,
          undefined,
          undefined,
          2,
        );
      }

      const consumed = await transaction.authToken.updateMany({
        where: { id: token.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) this.invalidToken();

      const account = await transaction.account.update({
        where: { id: token.accountId },
        data: {
          state: 'active',
          emailVerifiedAt: new Date(),
          rowVersion: { increment: 1 },
        },
      });
      const { body, sessionSecret } = await this.issueSession(
        transaction,
        account,
        previousSession,
      );
      await this.completeIdempotency(
        transaction,
        reservation.id,
        200,
        body,
        account.id,
        encryptSecret(this.environment.AUTH_TOKEN_ENCRYPTION_KEY, sessionSecret),
      );
      return { body, replayed: false, sessionSecret };
    });
  }

  async resendEmailVerification(
    request: EmailRequest,
    idempotencyKey: string,
    sessionSecret: string | undefined,
    ipAddress: string,
  ): Promise<CommandResult<{ accepted: true }>> {
    const sessionAccount = sessionSecret
      ? await this.accountForSession(sessionSecret, true)
      : undefined;
    const email = request.email ? normalizeEmail(request.email) : sessionAccount?.emailNormalized;
    const subject = email ?? 'anonymous-resend';
    const account =
      sessionAccount ??
      (email
        ? await this.database.account.findUnique({ where: { emailNormalized: email } })
        : undefined);
    const scope: IdempotencyScope = account
      ? { actorAccountId: account.id }
      : { publicSubjectHash: hmacSha256(this.environment.IDEMPOTENCY_HMAC_KEY, subject) };
    const requestHash = sha256(canonicalJson(request));
    const response = { accepted: true as const };
    const replay = await this.lookupIdempotency(
      scope,
      'POST /auth/email-verifications/resend',
      idempotencyKey,
      requestHash,
    );
    if (replay?.replay) return { body: response, replayed: true };

    await Promise.all([
      this.rateLimit.consume('resend-ip', ipAddress),
      this.rateLimit.consume('resend-email', subject),
    ]);

    return this.database.$transaction(async (transaction) => {
      const reservation = await this.reserveIdempotency(
        transaction,
        scope,
        'POST /auth/email-verifications/resend',
        idempotencyKey,
        requestHash,
      );
      if (reservation.replay) return { body: response, replayed: true };

      if (account?.state === 'active' && sessionAccount?.id === account.id) {
        throw new ApplicationError('ALREADY_VERIFIED', 'Электронная почта уже подтверждена.', 409);
      }
      if (account?.state === 'unverified') {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${account.id}::text, 0))::text AS locked
        `;
        const now = new Date();
        const currentAccount = await transaction.account.findUnique({ where: { id: account.id } });
        const latestToken = await transaction.authToken.findFirst({
          where: { accountId: account.id, purpose: 'email_verification' },
          orderBy: { createdAt: 'desc' },
        });
        const cooldownStartedAt = new Date(
          now.getTime() - this.environment.RESEND_COOLDOWN_SECONDS * 1000,
        );
        if (
          currentAccount?.state === 'unverified' &&
          (!latestToken || latestToken.createdAt <= cooldownStartedAt)
        ) {
          const rawToken = randomSecret();
          await transaction.authToken.updateMany({
            where: {
              accountId: account.id,
              purpose: 'email_verification',
              consumedAt: null,
            },
            data: { consumedAt: now },
          });
          await transaction.authToken.create({
            data: {
              id: uuidv7(),
              accountId: account.id,
              purpose: 'email_verification',
              tokenHash: databaseBytes(sha256(rawToken)),
              expiresAt: new Date(now.getTime() + this.environment.AUTH_TOKEN_TTL_SECONDS * 1000),
            },
          });
          await this.createOutboxEvent(transaction, {
            eventId: uuidv7(),
            eventType: 'identity.email-verification.requested',
            accountId: account.id,
            occurredAt: now,
            payload: {
              encryptedToken: encryptSecret(
                this.environment.AUTH_TOKEN_ENCRYPTION_KEY,
                rawToken,
              ).toString('base64'),
            },
            consumers: [EMAIL_CONSUMER],
          });
        }
      }
      await this.completeIdempotency(transaction, reservation.id, 202, response, account?.id);
      return { body: response, replayed: false };
    });
  }

  async getCurrentAccount(sessionSecret: string | undefined): Promise<CurrentAccount> {
    if (!sessionSecret) this.authRequired();
    const account = await this.accountForSession(sessionSecret);
    if (!account) this.authRequired();
    return {
      id: account.id,
      formalRole: account.formalRole,
      systemRole: account.systemRole,
      state: account.state,
      emailVerified: account.emailVerifiedAt !== null,
      capabilities:
        account.state === 'active' &&
        account.emailVerifiedAt &&
        (await this.hasConsents(account.id))
          ? ['profile.read', 'profile.edit']
          : account.state === 'unverified'
            ? ['email.verify', 'email.verification.resend']
            : [],
      ...(account.deletionIrreversibleAt
        ? { deletionIrreversibleAt: account.deletionIrreversibleAt.toISOString() }
        : {}),
      createdAt: account.createdAt.toISOString(),
    };
  }

  private async accountForSession(sessionSecret: string, _includeEmail = false) {
    const session = await this.database.session.findUnique({
      where: { sessionHash: databaseBytes(sha256(sessionSecret)) },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return undefined;
    const account = await this.database.account.findUnique({ where: { id: session.accountId } });
    return account?.state === 'deleted' ? undefined : account;
  }

  private async lockAccount(
    transaction: Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}::text, 0))::text AS locked`;
  }

  private csrfToken(secret: string, sessionId: string): string {
    return hmacSha256(secret, `csrf:v1:${sessionId}`).toString('base64url');
  }

  private async issueSession(
    transaction: Prisma.TransactionClient,
    account: { id: string; state: SessionView['accountState'] },
    previousSession?: string,
  ) {
    if (previousSession) {
      await transaction.session.updateMany({
        where: {
          sessionHash: databaseBytes(sha256(previousSession)),
          accountId: account.id,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }
    const id = uuidv7();
    const sessionSecret = randomSecret();
    const expiresAt = new Date(Date.now() + this.environment.AUTH_SESSION_TTL_SECONDS * 1000);
    await transaction.session.create({
      data: {
        id,
        accountId: account.id,
        sessionHash: databaseBytes(sha256(sessionSecret)),
        csrfSecretHash: databaseBytes(sha256(this.csrfToken(sessionSecret, id))),
        expiresAt,
        lastSeenAt: new Date(),
      },
    });
    return {
      body: {
        accountId: account.id,
        accountState: account.state,
        expiresAt: expiresAt.toISOString(),
      } satisfies SessionView,
      sessionSecret,
    };
  }

  private sessionReplay(reservation: IdempotencyReservation): CommandResult<SessionView> {
    if (!reservation.replay?.secret) throw new Error('IDEMPOTENCY_SECRET_MISSING');
    return {
      body: reservation.replay.body as SessionView,
      replayed: true,
      sessionSecret: decryptSecret(
        this.environment.AUTH_TOKEN_ENCRYPTION_KEY,
        reservation.replay.secret,
      ),
    };
  }

  async createSession(
    input: LoginRequest,
    key: string | undefined,
    ip: string,
    previousSession?: string,
  ): Promise<CommandResult<SessionView>> {
    const email = normalizeEmail(input.email);
    const account = await this.database.account.findUnique({
      where: { emailNormalized: email },
      include: { credential: true },
    });
    const scope = account
      ? { actorAccountId: account.id }
      : { publicSubjectHash: hmacSha256(this.environment.IDEMPOTENCY_HMAC_KEY, email) };
    const hash = hmacSha256(this.environment.IDEMPOTENCY_HMAC_KEY, canonicalJson(input));
    if (key) {
      const replay = await this.lookupIdempotency(scope, 'POST /auth/sessions', key, hash);
      if (replay?.replay) return this.sessionReplay(replay);
    }
    await Promise.all([
      this.rateLimit.consume('login-ip', ip),
      this.rateLimit.consume('login-email', email),
    ]);
    const passwordHash = account?.credential?.passwordHash ?? (await dummyPasswordHash);
    const valid = await argon2.verify(passwordHash, input.password);
    if (!valid || !account?.credential) this.invalidCredentials();
    return this.database.$transaction(async (transaction) => {
      await this.lockAccount(transaction, account.id);
      const reservation = key
        ? await this.reserveIdempotency(transaction, scope, 'POST /auth/sessions', key, hash)
        : undefined;
      if (reservation?.replay) return this.sessionReplay(reservation);
      const fresh = await transaction.account.findUnique({
        where: { id: account.id },
        include: { credential: true },
      });
      if (!fresh?.credential || fresh.credential.passwordHash !== passwordHash)
        this.invalidCredentials();
      if (fresh.state === 'deleted')
        throw new ApplicationError('ACCOUNT_DELETED', 'Аккаунт удалён.', 401);
      const result = await this.issueSession(transaction, fresh, previousSession);
      await transaction.account.update({
        where: { id: fresh.id },
        data: { lastLoginAt: new Date() },
      });
      if (reservation)
        await this.completeIdempotency(
          transaction,
          reservation.id,
          200,
          result.body,
          account.id,
          encryptSecret(this.environment.AUTH_TOKEN_ENCRYPTION_KEY, result.sessionSecret),
        );
      return { ...result, replayed: false };
    });
  }

  async getCsrfToken(secret: string | undefined): Promise<{ csrfToken: string }> {
    await this.authorizeSession(secret);
    const session = await this.database.session.findUniqueOrThrow({
      where: { sessionHash: databaseBytes(sha256(secret!)) },
    });
    const csrfToken = this.csrfToken(secret!, session.id);
    // Lazy upgrade of registration-era sessions. Deterministic across tabs and API instances.
    const updated = await this.database.session.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { csrfSecretHash: databaseBytes(sha256(csrfToken)), lastSeenAt: new Date() },
    });
    if (!updated.count) this.authRequired();
    return { csrfToken };
  }

  async authorizeSession(secret: string | undefined, active = false): Promise<CurrentAccount> {
    const account = await this.getCurrentAccount(secret);
    if (active) {
      if (account.state === 'unverified')
        throw new ApplicationError('ACCOUNT_UNVERIFIED', 'Подтвердите электронную почту.', 403);
      if (account.state === 'deleting')
        throw new ApplicationError('ACCOUNT_DELETING', 'Аккаунт удаляется. Доступ ограничен.', 403);
      if (!account.emailVerified || !account.capabilities.includes('profile.read'))
        throw new ApplicationError(
          'CONSENT_REQUIRED',
          'Для продолжения необходимы действующие обязательные согласия.',
          403,
        );
    }
    return account;
  }

  private async hasConsents(accountId: string): Promise<boolean> {
    return (
      (await this.database.consentStatus.count({
        where: { accountId, acceptedAt: { not: null }, revokedAt: null },
      })) === consentDocumentTypes.length
    );
  }

  private validateOrigin(origin: string | undefined): void {
    if (!origin || !this.environment.AUTH_ALLOWED_ORIGINS.includes(origin)) this.csrfFailed();
  }

  async validateCsrf(
    secret: string | undefined,
    origin: string | undefined,
    token: string | undefined,
  ): Promise<void> {
    this.validateOrigin(origin);
    await this.authorizeSession(secret);
    const session = await this.database.session.findUnique({
      where: { sessionHash: databaseBytes(sha256(secret!)) },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) this.authRequired();
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) this.csrfFailed();
    if (
      !timingSafeEqual(sha256(token), sha256(this.csrfToken(secret!, session.id))) ||
      !timingSafeEqual(Buffer.from(session.csrfSecretHash), sha256(token))
    )
      this.csrfFailed();
  }

  async deleteCurrentSession(
    secret: string | undefined,
    origin: string | undefined,
    csrf: string | undefined,
  ): Promise<void> {
    this.validateOrigin(origin);
    if (!secret || !(await this.accountForSession(secret))) return;
    await this.validateCsrf(secret, origin, csrf);
    await this.database.session.updateMany({
      where: { sessionHash: databaseBytes(sha256(secret)), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async requestPasswordReset(
    input: { email: string },
    key: string,
    ip: string,
  ): Promise<CommandResult<{ accepted: true }>> {
    const email = normalizeEmail(input.email);
    const account = await this.database.account.findUnique({ where: { emailNormalized: email } });
    const scope = account
      ? { actorAccountId: account.id }
      : { publicSubjectHash: hmacSha256(this.environment.IDEMPOTENCY_HMAC_KEY, email) };
    const requestHash = sha256(canonicalJson(input));
    const route = 'POST /auth/password-resets';
    const body = { accepted: true as const };
    const replay = await this.lookupIdempotency(scope, route, key, requestHash);
    if (replay?.replay) return { body, replayed: true };
    await Promise.all([
      this.rateLimit.consume('reset-ip', ip),
      this.rateLimit.consume('reset-email', email),
    ]);
    return this.database.$transaction(async (transaction) => {
      if (account) await this.lockAccount(transaction, account.id);
      const reservation = await this.reserveIdempotency(
        transaction,
        scope,
        route,
        key,
        requestHash,
      );
      if (reservation.replay) return { body, replayed: true };
      const fresh = account
        ? await transaction.account.findUnique({ where: { id: account.id } })
        : null;
      if (fresh && ['active', 'unverified'].includes(fresh.state)) {
        const latest = await transaction.authToken.findFirst({
          where: { accountId: fresh.id, purpose: 'password_reset' },
          orderBy: { createdAt: 'desc' },
        });
        const now = new Date();
        if (
          !latest ||
          latest.createdAt.getTime() <=
            now.getTime() - this.environment.RESEND_COOLDOWN_SECONDS * 1000
        ) {
          const rawToken = randomSecret();
          await transaction.authToken.updateMany({
            where: { accountId: fresh.id, purpose: 'password_reset', consumedAt: null },
            data: { consumedAt: now },
          });
          await transaction.authToken.create({
            data: {
              id: uuidv7(),
              accountId: fresh.id,
              purpose: 'password_reset',
              tokenHash: databaseBytes(sha256(rawToken)),
              expiresAt: new Date(now.getTime() + this.environment.AUTH_RESET_TTL_SECONDS * 1000),
            },
          });
          await this.createOutboxEvent(transaction, {
            eventId: uuidv7(),
            eventType: 'identity.password-reset.requested',
            accountId: fresh.id,
            occurredAt: now,
            payload: {
              encryptedToken: encryptSecret(
                this.environment.AUTH_TOKEN_ENCRYPTION_KEY,
                rawToken,
              ).toString('base64'),
            },
            consumers: ['identity.password-reset-email'],
          });
        }
      }
      await this.completeIdempotency(transaction, reservation.id, 202, body, account?.id);
      return { body, replayed: false };
    });
  }

  async confirmPasswordReset(
    input: PasswordResetConfirm,
    key: string,
    ip: string,
  ): Promise<CommandResult<null>> {
    const token = await this.database.authToken.findUnique({
      where: { tokenHash: databaseBytes(sha256(input.token)) },
    });
    if (!token || token.purpose !== 'password_reset') {
      await this.rateLimit.consume('reset-confirm-ip', ip);
      this.invalidToken();
    }
    const scope = { actorAccountId: token.accountId };
    const route = 'POST /auth/password-resets/confirm';
    const requestHash = sha256(canonicalJson(input));
    const replay = await this.lookupIdempotency(scope, route, key, requestHash);
    if (replay?.replay) return { body: null, replayed: true };
    await Promise.all([
      this.rateLimit.consume('reset-confirm-ip', ip),
      this.rateLimit.consume('reset-confirm-account', token.accountId),
    ]);
    const credential = await this.database.credential.findUnique({
      where: { accountId: token.accountId },
    });
    if (!credential || token.consumedAt || token.expiresAt <= new Date()) this.invalidToken();
    const reused = await argon2.verify(credential.passwordHash, input.password);
    const passwordHash = reused ? undefined : await argon2.hash(input.password, ARGON2_PARAMETERS);
    return this.database.$transaction(async (transaction) => {
      await this.lockAccount(transaction, token.accountId);
      const reservation = await this.reserveIdempotency(
        transaction,
        scope,
        route,
        key,
        requestHash,
      );
      if (reservation.replay) return { body: null, replayed: true };
      const account = await transaction.account.findUnique({
        where: { id: token.accountId },
        include: { credential: true },
      });
      const fresh = await transaction.authToken.findUnique({ where: { id: token.id } });
      if (
        !account ||
        !['active', 'unverified'].includes(account.state) ||
        account.credential?.passwordHash !== credential.passwordHash ||
        !fresh ||
        fresh.consumedAt ||
        fresh.expiresAt <= new Date()
      )
        this.invalidToken();
      if (reused)
        throw new ApplicationError(
          'PASSWORD_REUSED',
          'Новый пароль должен отличаться от текущего.',
          409,
        );
      const now = new Date();
      await transaction.credential.update({
        where: { accountId: account.id },
        data: {
          passwordHash: passwordHash!,
          argon2Parameters: {
            version: 1,
            algorithm: 'argon2id',
            memoryCost: ARGON2_PARAMETERS.memoryCost,
            timeCost: ARGON2_PARAMETERS.timeCost,
            parallelism: 1,
            hashLength: 32,
          },
          passwordChangedAt: now,
        },
      });
      await transaction.authToken.updateMany({
        where: { accountId: account.id, purpose: 'password_reset', consumedAt: null },
        data: { consumedAt: now },
      });
      await transaction.session.updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.completeIdempotency(transaction, reservation.id, 204, Prisma.JsonNull, account.id);
      return { body: null, replayed: false };
    });
  }

  recordAuthResult(operation: string, result: string): void {
    authCounter.add(1, { operation, result });
  }

  private invalidCredentials(): never {
    throw new ApplicationError('INVALID_CREDENTIALS', 'Неверная почта или пароль.', 401);
  }
  private csrfFailed(): never {
    csrfCounter.add(1);
    throw new ApplicationError(
      'CSRF_FAILED',
      'Проверка безопасности не пройдена. Обновите страницу.',
      403,
    );
  }

  private async reserveIdempotency(
    transaction: Prisma.TransactionClient,
    scope: IdempotencyScope,
    route: string,
    key: string,
    requestHash: Buffer,
  ): Promise<IdempotencyReservation> {
    const id = uuidv7();
    await transaction.idempotencyRecord.deleteMany({
      where: {
        route,
        key,
        expiresAt: { lte: new Date() },
        ...(scope.actorAccountId
          ? { actorAccountId: scope.actorAccountId }
          : { publicSubjectHash: databaseBytes(scope.publicSubjectHash!) }),
      },
    });
    const inserted = scope.actorAccountId
      ? await transaction.$executeRaw`
          INSERT INTO platform.idempotency_records
            (id, actor_account_id, route, key, request_hash, state, expires_at)
          VALUES
            (${id}::uuid, ${scope.actorAccountId}::uuid, ${route}, ${key}, ${requestHash}, 'in_progress', ${new Date(Date.now() + IDEMPOTENCY_TTL_MS)})
          ON CONFLICT (actor_account_id, route, key) WHERE actor_account_id IS NOT NULL DO NOTHING
        `
      : await transaction.$executeRaw`
          INSERT INTO platform.idempotency_records
            (id, public_subject_hash, route, key, request_hash, state, expires_at)
          VALUES
            (${id}::uuid, ${scope.publicSubjectHash!}, ${route}, ${key}, ${requestHash}, 'in_progress', ${new Date(Date.now() + IDEMPOTENCY_TTL_MS)})
          ON CONFLICT (public_subject_hash, route, key) WHERE public_subject_hash IS NOT NULL DO NOTHING
        `;
    if (inserted === 1) return { id };

    const existing = await transaction.idempotencyRecord.findFirst({
      where: {
        route,
        key,
        expiresAt: { gt: new Date() },
        ...(scope.actorAccountId
          ? { actorAccountId: scope.actorAccountId }
          : { publicSubjectHash: databaseBytes(scope.publicSubjectHash!) }),
      },
    });
    if (!existing) {
      throw new ApplicationError(
        'IDEMPOTENCY_IN_PROGRESS',
        'Предыдущий запрос ещё выполняется. Повторите попытку позже.',
        409,
        true,
        undefined,
        undefined,
        1,
      );
    }
    return this.evaluateIdempotency(existing, requestHash);
  }

  private async lookupIdempotency(
    scope: IdempotencyScope,
    route: string,
    key: string,
    requestHash: Buffer,
  ): Promise<IdempotencyReservation | undefined> {
    const existing = await this.database.idempotencyRecord.findFirst({
      where: {
        route,
        key,
        expiresAt: { gt: new Date() },
        ...(scope.actorAccountId
          ? { actorAccountId: scope.actorAccountId }
          : { publicSubjectHash: databaseBytes(scope.publicSubjectHash!) }),
      },
    });
    return existing ? this.evaluateIdempotency(existing, requestHash) : undefined;
  }

  private evaluateIdempotency(
    existing: StoredIdempotencyRecord,
    requestHash: Buffer,
  ): IdempotencyReservation {
    if (!bufferEquals(existing.requestHash, requestHash)) {
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REUSED',
        'Этот ключ повтора уже использован с другими данными.',
        409,
      );
    }
    if (existing.state !== 'completed' || existing.responseStatus === null) {
      throw new ApplicationError(
        'IDEMPOTENCY_IN_PROGRESS',
        'Предыдущий запрос ещё выполняется. Повторите попытку позже.',
        409,
        true,
        undefined,
        undefined,
        1,
      );
    }
    return {
      id: existing.id,
      replay: {
        status: existing.responseStatus,
        body: existing.responseBody,
        ...(existing.responseSecret ? { secret: existing.responseSecret } : {}),
      },
    };
  }

  private async completeIdempotency(
    transaction: Prisma.TransactionClient,
    id: string,
    status: number,
    body: unknown,
    responseRefId?: string,
    responseSecret?: Buffer,
  ): Promise<void> {
    await transaction.idempotencyRecord.update({
      where: { id },
      data: {
        state: 'completed',
        responseStatus: status,
        responseRefType: responseRefId ? 'account' : undefined,
        responseRefId,
        responseBody: body as Prisma.InputJsonValue,
        responseSecret: responseSecret ? databaseBytes(responseSecret) : undefined,
      },
    });
  }

  private async createOutboxEvent(
    transaction: Prisma.TransactionClient,
    input: {
      eventId: string;
      eventType: string;
      accountId: string;
      occurredAt: Date;
      payload: Prisma.InputJsonValue;
      consumers: string[];
    },
  ): Promise<void> {
    const context = getRequestContext();
    await transaction.outboxEvent.create({
      data: {
        id: input.eventId,
        eventType: input.eventType,
        eventVersion: 1,
        aggregateType: 'account',
        aggregateId: input.accountId,
        occurredAt: input.occurredAt,
        correlationId: context?.correlationId ?? uuidv7(),
        actorAccountId: input.accountId,
        payload: input.payload,
        deliveries: {
          create: input.consumers.map((consumer) => ({
            id: uuidv7(),
            consumer,
            availableAt: input.occurredAt,
          })),
        },
      },
    });
  }

  private invalidToken(): never {
    throw new ApplicationError(
      'TOKEN_INVALID_OR_EXPIRED',
      'Ссылка недействительна или устарела. Запросите новое письмо.',
      401,
    );
  }

  private authRequired(): never {
    throw new ApplicationError('AUTH_REQUIRED', 'Войдите в аккаунт, чтобы продолжить.', 401);
  }
}

export { normalizeEmail };
