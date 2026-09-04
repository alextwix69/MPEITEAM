import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { Prisma } from '@prisma/client';
import argon2 from 'argon2';
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
import type { EmailRequest, RegistrationRequest } from '../identity.schemas';
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
  ): Promise<CommandResult<SessionView>> {
    const tokenHash = sha256(rawToken);
    const token = await this.database.authToken.findUnique({
      where: { tokenHash: databaseBytes(tokenHash) },
    });
    if (!token) this.invalidToken();
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

      const sessionSecret = randomSecret();
      const csrfSecret = randomSecret();
      const expiresAt = new Date(Date.now() + this.environment.AUTH_SESSION_TTL_SECONDS * 1000);
      const account = await transaction.account.update({
        where: { id: token.accountId },
        data: {
          state: 'active',
          emailVerifiedAt: new Date(),
          rowVersion: { increment: 1 },
        },
      });
      await transaction.session.create({
        data: {
          id: uuidv7(),
          accountId: account.id,
          sessionHash: databaseBytes(sha256(sessionSecret)),
          csrfSecretHash: databaseBytes(sha256(csrfSecret)),
          expiresAt,
          lastSeenAt: new Date(),
        },
      });
      const body: SessionView = {
        accountId: account.id,
        accountState: account.state,
        expiresAt: expiresAt.toISOString(),
      };
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
        account.state === 'active'
          ? ['profile.read', 'profile.edit']
          : ['email.verify', 'email.verification.resend'],
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
    return this.database.account.findUnique({ where: { id: session.accountId } });
  }

  private async reserveIdempotency(
    transaction: Prisma.TransactionClient,
    scope: IdempotencyScope,
    route: string,
    key: string,
    requestHash: Buffer,
  ): Promise<IdempotencyReservation> {
    const id = uuidv7();
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
