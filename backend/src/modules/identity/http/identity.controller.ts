import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import type { ApiEnvironment } from '../../../platform/config/env.schema';
import { ApplicationError } from '../../../platform/http/application-error';
import { IdentityService } from '../application/identity.service';
import {
  emailRequestSchema,
  idempotencyKeySchema,
  registrationRequestSchema,
  tokenRequestSchema,
} from '../identity.schemas';
import { IDENTITY_ENVIRONMENT } from '../identity.tokens';
import { metrics } from '@opentelemetry/api';

const identityMeter = metrics.getMeter('komanda-mpei-identity');
const registrationCounter = identityMeter.createCounter('identity.registration.requests');
const verificationCounter = identityMeter.createCounter('identity.email_verification.requests');
const resendCounter = identityMeter.createCounter('identity.email_verification.resends');

function parseExternal<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApplicationError(
    'INVALID_REQUEST',
    'Проверьте заполненные поля и повторите попытку.',
    422,
    false,
    undefined,
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code.toUpperCase(),
      message: issue.message,
    })),
  );
}

function sessionFromCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === '__Host-session') return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function setReplayHeader(response: Response, replayed: boolean): void {
  if (replayed) response.setHeader('Idempotency-Replayed', 'true');
}

function failureMetricResult(error: unknown): 'failed' | 'rate_limited' {
  return error instanceof ApplicationError && error.code === 'RATE_LIMITED'
    ? 'rate_limited'
    : 'failed';
}

@Controller()
export class IdentityController {
  constructor(
    @Inject(IdentityService)
    private readonly identity: IdentityService,
    @Inject(IDENTITY_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  @Post('auth/registrations')
  async register(
    @Body() body: unknown,
    @Headers('idempotency-key') keyValue: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      const input = parseExternal(registrationRequestSchema, body);
      const key = parseExternal(idempotencyKeySchema, keyValue);
      const result = await this.identity.register(input, key, request.ip ?? 'unknown');
      registrationCounter.add(1, { result: result.replayed ? 'replayed' : 'created' });
      setReplayHeader(response, result.replayed);
      return result.body;
    } catch (error) {
      registrationCounter.add(1, { result: failureMetricResult(error) });
      throw error;
    }
  }

  @Post('auth/email-verifications')
  @HttpCode(200)
  async verifyEmail(
    @Body() body: unknown,
    @Headers('idempotency-key') keyValue: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      const input = parseExternal(tokenRequestSchema, body);
      const key = parseExternal(idempotencyKeySchema, keyValue);
      result = await this.identity.verifyEmail(input.token, key, request.ip ?? 'unknown');
      verificationCounter.add(1, { result: result.replayed ? 'replayed' : 'activated' });
    } catch (error) {
      verificationCounter.add(1, { result: failureMetricResult(error) });
      throw error;
    }
    if (!result.sessionSecret) throw new Error('SESSION_SECRET_MISSING');
    response.setHeader('Cache-Control', 'no-store');
    response.cookie('__Host-session', result.sessionSecret, {
      secure: this.environment.SESSION_COOKIE_SECURE,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.environment.AUTH_SESSION_TTL_SECONDS * 1000,
    });
    setReplayHeader(response, result.replayed);
    return result.body;
  }

  @Post('auth/email-verifications/resend')
  @HttpCode(202)
  async resend(
    @Body() body: unknown,
    @Headers('idempotency-key') keyValue: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      const input = parseExternal(emailRequestSchema, body ?? {});
      const key = parseExternal(idempotencyKeySchema, keyValue);
      const result = await this.identity.resendEmailVerification(
        input,
        key,
        sessionFromCookie(cookie),
        request.ip ?? 'unknown',
      );
      resendCounter.add(1, { result: result.replayed ? 'replayed' : 'accepted' });
      setReplayHeader(response, result.replayed);
      return result.body;
    } catch (error) {
      resendCounter.add(1, { result: failureMetricResult(error) });
      throw error;
    }
  }

  @Get('me')
  async getCurrentAccount(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.identity.getCurrentAccount(sessionFromCookie(cookie));
  }
}

export { parseExternal, sessionFromCookie };
