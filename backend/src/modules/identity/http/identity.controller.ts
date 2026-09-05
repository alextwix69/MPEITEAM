import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
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
  loginRequestSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
} from '../identity.schemas';
import { IDENTITY_ENVIRONMENT } from '../identity.tokens';
import { metrics } from '@opentelemetry/api';
import { Access } from '../../../platform/http/route-access';
import { sessionFromCookie } from './session-cookie';
import type { CommandResult, SessionView } from '../identity.types';

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
  @Access('public')
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
  @Access('public')
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
      result = await this.identity.verifyEmail(
        input.token,
        key,
        request.ip ?? 'unknown',
        sessionFromCookie(request.headers.cookie),
      );
      verificationCounter.add(1, { result: result.replayed ? 'replayed' : 'activated' });
    } catch (error) {
      verificationCounter.add(1, { result: failureMetricResult(error) });
      throw error;
    }
    this.setSessionCookie(response, result);
    setReplayHeader(response, result.replayed);
    return result.body;
  }

  @Post('auth/email-verifications/resend')
  @Access('public')
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
  @Access('session')
  async getCurrentAccount(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.identity.getCurrentAccount(sessionFromCookie(cookie));
  }

  @Get('auth/csrf')
  @Access('session')
  async csrf(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.identity.getCsrfToken(sessionFromCookie(cookie));
  }

  @Post('auth/sessions')
  @HttpCode(200)
  @Access('public')
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authCommand('login', async () =>
      this.identity.createSession(
        parseExternal(loginRequestSchema, body),
        request.get('idempotency-key') === undefined
          ? undefined
          : parseExternal(idempotencyKeySchema, request.get('idempotency-key')),
        request.ip ?? 'unknown',
        sessionFromCookie(request.headers.cookie),
      ),
    );
    this.setSessionCookie(response, result);
    setReplayHeader(response, result.replayed);
    return result.body;
  }

  @Delete('auth/session')
  @HttpCode(204)
  @Access('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.authCommand('logout', () =>
      this.identity.deleteCurrentSession(
        sessionFromCookie(request.headers.cookie),
        request.get('origin'),
        request.get('x-csrf-token'),
      ),
    );
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie('__Host-session', {
      secure: this.environment.SESSION_COOKIE_SECURE,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  }

  @Post('auth/password-resets')
  @HttpCode(202)
  @Access('public')
  async requestReset(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authCommand('reset_request', () =>
      this.identity.requestPasswordReset(
        parseExternal(passwordResetRequestSchema, body),
        parseExternal(idempotencyKeySchema, request.get('idempotency-key')),
        request.ip ?? 'unknown',
      ),
    );
    response.setHeader('Cache-Control', 'no-store');
    setReplayHeader(response, result.replayed);
    return result.body;
  }

  @Post('auth/password-resets/confirm')
  @HttpCode(204)
  @Access('public')
  async confirmReset(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authCommand('reset_confirm', () =>
      this.identity.confirmPasswordReset(
        parseExternal(passwordResetConfirmSchema, body),
        parseExternal(idempotencyKeySchema, request.get('idempotency-key')),
        request.ip ?? 'unknown',
      ),
    );
    response.setHeader('Cache-Control', 'no-store');
    setReplayHeader(response, result.replayed);
  }

  private setSessionCookie(response: Response, result: CommandResult<SessionView>): void {
    if (!result.sessionSecret) throw new Error('SESSION_SECRET_MISSING');
    response.setHeader('Cache-Control', 'no-store');
    response.cookie('__Host-session', result.sessionSecret, {
      secure: this.environment.SESSION_COOKIE_SECURE,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(result.body.expiresAt),
    });
  }

  private async authCommand<T>(operation: string, command: () => Promise<T>): Promise<T> {
    try {
      const result = await command();
      this.identity.recordAuthResult(operation, 'completed');
      return result;
    } catch (error) {
      this.identity.recordAuthResult(operation, failureMetricResult(error));
      throw error;
    }
  }
}

export { parseExternal, sessionFromCookie };
