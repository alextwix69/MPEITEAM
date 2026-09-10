import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import type { CurrentAccount } from '../../identity';
import { ApplicationError } from '../../../platform/http/application-error';
import { Access } from '../../../platform/http/route-access';
import { NotificationsService } from '../application/notifications.service';
import {
  idempotencyKeySchema,
  ifMatchSchema,
  notificationQuerySchema,
  notificationUpdateSchema,
  readAllNotificationsSchema,
  uuidSchema,
} from '../notifications.schemas';

type AuthenticatedRequest = Request & { currentAccount?: CurrentAccount };

function parseExternal<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApplicationError(
    'INVALID_REQUEST',
    'Проверьте данные запроса.',
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

@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  @Access('active')
  list(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    return this.notifications.list(
      this.accountId(request),
      parseExternal(notificationQuerySchema, query),
    );
  }

  @Patch(':notificationId')
  @Access('active')
  async markRead(
    @Param('notificationId') notificationId: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    parseExternal(notificationUpdateSchema, body);
    const result = await this.notifications.markRead(
      this.accountId(request),
      parseExternal(uuidSchema, notificationId),
      this.expectedVersion(ifMatch),
      idempotencyKey === undefined
        ? undefined
        : parseExternal(idempotencyKeySchema, idempotencyKey),
    );
    response.setHeader('ETag', `"${result.body.rowVersion}"`);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Post('read-all')
  @Access('active')
  @HttpCode(200)
  async markAllRead(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseExternal(readAllNotificationsSchema, body ?? {});
    const before = input.before ? new Date(input.before) : undefined;
    if (before && before.getTime() > Date.now()) {
      throw new ApplicationError('INVALID_REQUEST', 'Момент before не может быть в будущем.', 422);
    }
    const result = await this.notifications.markAllRead(
      this.accountId(request),
      before,
      parseExternal(idempotencyKeySchema, idempotencyKey),
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  private expectedVersion(value: string | undefined): number {
    if (value === undefined) {
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Для изменения нужен If-Match.', 428);
    }
    return Number(parseExternal(ifMatchSchema, value).slice(1, -1));
  }

  private accountId(request: AuthenticatedRequest): string {
    if (!request.currentAccount)
      throw new ApplicationError('AUTH_REQUIRED', 'Войдите в аккаунт.', 401);
    return request.currentAccount.id;
  }
}
