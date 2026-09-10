import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ApplicationError } from '../../../platform/http/application-error';
import { Access } from '../../../platform/http/route-access';
import { FilesService } from '../application/files.service';
import { idempotencyKeySchema, uploadCreateSchema, uuidSchema } from '../application/files.schemas';
import type { UploadCreateInput } from '../files.types';
import type { CurrentAccount } from '../../identity';

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
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post('uploads')
  @Access('active')
  async createUpload(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.files.createUploadSession(
      this.accountId(request),
      parseExternal(uploadCreateSchema, body) as UploadCreateInput,
      parseExternal(idempotencyKeySchema, idempotencyKey),
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    response.statusCode = 201;
    return result.body;
  }

  @Get('uploads/:uploadId')
  @Access('active')
  async getUpload(@Param('uploadId') uploadId: string, @Req() request: AuthenticatedRequest) {
    return this.files.getUploadSession(
      this.accountId(request),
      parseExternal(uuidSchema, uploadId),
    );
  }

  @Post('uploads/:uploadId/complete')
  @Access('active')
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.files.completeUpload(
      this.accountId(request),
      parseExternal(uuidSchema, uploadId),
      parseExternal(idempotencyKeySchema, idempotencyKey),
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    response.statusCode = 202;
    return result.body;
  }

  @Get('media/:mediaId/download-url')
  @Access('active')
  async downloadUrl(
    @Param('mediaId') mediaId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.files.createDownloadUrl(
      this.accountId(request),
      parseExternal(uuidSchema, mediaId),
    );
  }

  private accountId(request: AuthenticatedRequest): string {
    if (!request.currentAccount) {
      throw new ApplicationError('AUTH_REQUIRED', 'Войдите в аккаунт, чтобы продолжить.', 401);
    }
    return request.currentAccount.id;
  }
}

export { parseExternal };
