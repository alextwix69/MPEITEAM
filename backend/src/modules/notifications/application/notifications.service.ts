import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Notification, Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseService } from '../../../platform/database/database.service';
import { ApplicationError } from '../../../platform/http/application-error';
import { runIdempotentCommand } from '../../../platform/idempotency/idempotent-command';
import { moderationResultPayloadSchema } from '../notifications.schemas';
import { NOTIFICATIONS_CURSOR_KEY } from '../notifications.tokens';
import type {
  ClaimedEmailDelivery,
  ModerationResultEvent,
  NotificationView,
} from '../notifications.types';

interface CursorValue {
  createdAt: string;
  id: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NOTIFICATIONS_CURSOR_KEY) private readonly cursorKey: string,
  ) {}

  async list(
    accountId: string,
    query: { limit: number; cursor?: string; unreadOnly?: boolean; type?: string },
  ) {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const rows = await this.database.notification.findMany({
      where: {
        recipientAccountId: accountId,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => this.toView(row)),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? this.encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      },
    };
  }

  async markRead(
    accountId: string,
    notificationId: string,
    expectedVersion: number,
    idempotencyKey?: string,
  ) {
    const execute = async (transaction: Prisma.TransactionClient) => {
      const current = await transaction.notification.findFirst({
        where: { id: notificationId, recipientAccountId: accountId },
      });
      if (!current) this.notFound();
      if (current.readAt) {
        return {
          body: this.toView(current),
          responseRefType: 'notification',
          responseRefId: current.id,
          status: 200,
        };
      }
      const changed = await transaction.notification.updateMany({
        where: {
          id: notificationId,
          recipientAccountId: accountId,
          rowVersion: BigInt(expectedVersion),
        },
        data: { readAt: new Date(), rowVersion: { increment: 1 } },
      });
      if (changed.count !== 1) this.mismatch(Number(current.rowVersion));
      const updated = await transaction.notification.findUniqueOrThrow({
        where: { id: notificationId },
      });
      return {
        body: this.toView(updated),
        responseRefType: 'notification',
        responseRefId: notificationId,
        status: 200,
      };
    };
    if (idempotencyKey) {
      return runIdempotentCommand(
        this.database,
        accountId,
        'PATCH /notifications/{notificationId}',
        idempotencyKey,
        { notificationId, read: true },
        execute,
      );
    }
    const value = await this.database.$transaction(execute);
    return { body: value.body, replayed: false, status: 200 };
  }

  markAllRead(accountId: string, before: Date | undefined, idempotencyKey: string) {
    return runIdempotentCommand(
      this.database,
      accountId,
      'POST /notifications/read-all',
      idempotencyKey,
      { before: before?.toISOString() ?? null },
      async (transaction) => {
        const highWater = before ?? new Date();
        const changed = await transaction.notification.updateMany({
          where: {
            recipientAccountId: accountId,
            readAt: null,
            createdAt: { lte: highWater },
          },
          data: { readAt: new Date(), rowVersion: { increment: 1 } },
        });
        return {
          body: { updatedCount: changed.count },
          responseRefType: 'notification_batch',
          responseRefId: accountId,
          status: 200,
        };
      },
    );
  }

  async consumeModerationResult(event: ModerationResultEvent): Promise<void> {
    if (event.eventVersion !== 1) throw new Error('EVENT_VERSION_UNSUPPORTED');
    const payload = moderationResultPayloadSchema.parse(event.payload);
    await this.database.$transaction(async (transaction) => {
      const inserted = await transaction.$executeRaw`
        INSERT INTO notifications.inbox_events (event_id, consumer, event_version, processed_at)
        VALUES (${event.id}::uuid, 'notifications.moderation-result', 1, now())
        ON CONFLICT (event_id) DO NOTHING
      `;
      if (inserted !== 1) return;
      const notificationId = uuidv7();
      const type = payload.approved ? 'moderation_approved' : 'moderation_revision_required';
      await transaction.notification.create({
        data: {
          id: notificationId,
          recipientAccountId: payload.recipientAccountId,
          sourceEventId: event.id,
          type,
          resourceType: payload.contentType,
          resourceId: payload.contentId,
          payload: {
            decisionId: payload.decisionId,
            approved: payload.approved,
            violationCodes: payload.violationCodes,
            ...(payload.reason ? { reason: payload.reason } : {}),
          },
        },
      });
      await transaction.emailDelivery.create({
        data: {
          id: uuidv7(),
          sourceEventId: event.id,
          recipientAccountId: payload.recipientAccountId,
          templateCode: type,
          providerMessageKey: `moderation-${event.id}`,
          availableAt: new Date(),
        },
      });
      await transaction.notificationsInboxEvent.update({
        where: { eventId: event.id },
        data: { resultRefId: notificationId },
      });
    });
  }

  async claimEmailDelivery(): Promise<ClaimedEmailDelivery | undefined> {
    const now = new Date();
    const delivery = await this.database.emailDelivery.findFirst({
      where: {
        OR: [
          { state: { in: ['pending', 'failed'] }, availableAt: { lte: now } },
          { state: 'sending', leaseUntil: { lt: now } },
        ],
      },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
    });
    if (!delivery) return undefined;
    const changed = await this.database.emailDelivery.updateMany({
      where: {
        id: delivery.id,
        rowVersion: delivery.rowVersion,
        OR: [
          { state: { in: ['pending', 'failed'] }, availableAt: { lte: now } },
          { state: 'sending', leaseUntil: { lt: now } },
        ],
      },
      data: {
        state: 'sending',
        leaseUntil: new Date(Date.now() + 30_000),
        attemptCount: { increment: 1 },
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) return undefined;
    const notification = await this.database.notification.findFirst({
      where: {
        sourceEventId: delivery.sourceEventId,
        recipientAccountId: delivery.recipientAccountId,
      },
    });
    if (!notification) throw new Error('NOTIFICATION_NOT_FOUND');
    const payload = moderationResultPayloadSchema
      .pick({
        approved: true,
        contentType: true,
        contentId: true,
        violationCodes: true,
        reason: true,
      })
      .parse({
        approved: notification.type === 'moderation_approved',
        contentType: notification.resourceType,
        contentId: notification.resourceId,
        ...(notification.payload as Record<string, unknown>),
      });
    return {
      id: delivery.id,
      sourceEventId: delivery.sourceEventId,
      recipientAccountId: delivery.recipientAccountId,
      providerMessageKey: delivery.providerMessageKey,
      attemptCount: delivery.attemptCount + 1,
      rowVersion: delivery.rowVersion + 1n,
      payload,
    };
  }

  async completeEmailDelivery(delivery: ClaimedEmailDelivery): Promise<void> {
    const changed = await this.database.emailDelivery.updateMany({
      where: { id: delivery.id, state: 'sending', rowVersion: delivery.rowVersion },
      data: {
        state: 'sent',
        sentAt: new Date(),
        leaseUntil: null,
        lastErrorCode: null,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new Error('DELIVERY_LEASE_LOST');
  }

  async failEmailDelivery(delivery: ClaimedEmailDelivery): Promise<void> {
    const deadLetter = delivery.attemptCount >= 5;
    await this.database.emailDelivery.updateMany({
      where: { id: delivery.id, state: 'sending', rowVersion: delivery.rowVersion },
      data: {
        state: deadLetter ? 'dead_letter' : 'failed',
        leaseUntil: null,
        availableAt: new Date(Date.now() + Math.min(60_000, 2 ** delivery.attemptCount * 1000)),
        lastErrorCode: 'EMAIL_DELIVERY_FAILED',
        rowVersion: { increment: 1 },
      },
    });
  }

  private toView(row: Notification): NotificationView {
    return {
      id: row.id,
      type: row.type,
      ...(row.resourceType ? { resourceType: row.resourceType } : {}),
      ...(row.resourceId ? { resourceId: row.resourceId } : {}),
      payload: row.payload as Record<string, unknown>,
      read: row.readAt !== null,
      ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
      rowVersion: Number(row.rowVersion),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private encodeCursor(value: CursorValue): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', this.cursorKey).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decodeCursor(value: string): CursorValue {
    try {
      const [body, signature, extra] = value.split('.');
      if (!body || !signature || extra) throw new Error('invalid cursor');
      const expected = createHmac('sha256', this.cursorKey).update(body).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('invalid cursor');
      }
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorValue;
      if (!parsed.id || !parsed.createdAt || Number.isNaN(new Date(parsed.createdAt).getTime())) {
        throw new Error('invalid cursor');
      }
      return parsed;
    } catch {
      throw new ApplicationError(
        'INVALID_CURSOR',
        'Курсор устарел или повреждён. Обновите список.',
        422,
      );
    }
  }

  private mismatch(currentVersion: number): never {
    throw new ApplicationError(
      'VERSION_MISMATCH',
      'Уведомление уже изменилось. Обновите список.',
      412,
      false,
      { currentVersion },
    );
  }

  private notFound(): never {
    throw new ApplicationError('NOTIFICATION_NOT_FOUND', 'Уведомление не найдено.', 404);
  }
}
