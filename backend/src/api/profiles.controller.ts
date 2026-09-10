import { Body, Controller, Get, Headers, Inject, Param, Patch, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import type { CurrentAccount } from '../modules/identity';
import {
  idempotencyKeySchema,
  ifMatchSchema,
  profileInputSchema,
  resumeInputSchema,
  uuidSchema,
} from '../modules/profiles/profiles.schemas';
import { ApplicationError } from '../platform/http/application-error';
import { Access } from '../platform/http/route-access';
import { ProfileWorkflowService } from './profile-workflow.service';

type AuthenticatedRequest = Request & { currentAccount?: CurrentAccount };

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

@Controller()
export class ProfilesController {
  constructor(@Inject(ProfileWorkflowService) private readonly workflow: ProfileWorkflowService) {}

  @Get('me/profile')
  @Access('active')
  async getOwnProfile(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const body = await this.workflow.getOwnProfile(this.accountId(request));
    this.etag(response, body.rowVersion);
    return body;
  }

  @Patch('me/profile')
  @Access('active')
  async updateOwnProfile(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.workflow.updateOwnProfile(
      this.accountId(request),
      parseExternal(profileInputSchema, body),
      this.expectedVersion(ifMatch),
      parseExternal(idempotencyKeySchema, idempotencyKey),
    );
    response.statusCode = 202;
    this.etag(response, result.body.rowVersion);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Get('profiles/:accountId')
  @Access('active')
  getPublicProfile(@Param('accountId') accountId: string) {
    return this.workflow.getPublicProfile(parseExternal(uuidSchema, accountId));
  }

  @Get('me/resumes')
  @Access('active')
  async listOwnResumes(@Req() request: AuthenticatedRequest) {
    return { items: await this.workflow.listOwnResumes(this.accountId(request)) };
  }

  @Get('me/resumes/:resumeId')
  @Access('active')
  async getOwnResume(
    @Param('resumeId') resumeId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const body = await this.workflow.getOwnResume(
      this.accountId(request),
      parseExternal(uuidSchema, resumeId),
    );
    this.etag(response, body.rowVersion);
    return body;
  }

  @Patch('me/resumes/:resumeId')
  @Access('active')
  async updateOwnResume(
    @Param('resumeId') resumeId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.workflow.updateOwnResume(
      this.accountId(request),
      parseExternal(uuidSchema, resumeId),
      parseExternal(resumeInputSchema, body),
      this.expectedVersion(ifMatch),
      parseExternal(idempotencyKeySchema, idempotencyKey),
    );
    response.statusCode = 202;
    this.etag(response, result.body.rowVersion);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  private expectedVersion(value: string | undefined): number {
    if (value === undefined) {
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'Обновите страницу и повторите запрос с If-Match.',
        428,
      );
    }
    return Number(parseExternal(ifMatchSchema, value).slice(1, -1));
  }

  private etag(response: Response, rowVersion: number): void {
    response.setHeader('ETag', `"${rowVersion}"`);
  }

  private accountId(request: AuthenticatedRequest): string {
    if (!request.currentAccount) {
      throw new ApplicationError('AUTH_REQUIRED', 'Войдите в аккаунт, чтобы продолжить.', 401);
    }
    return request.currentAccount.id;
  }
}
