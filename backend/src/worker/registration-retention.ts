import type { PrismaClient } from '@prisma/client';

export const TERMINAL_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const COMPLETED_OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function purgeMainRegistrationState(database: PrismaClient, now: Date): Promise<void> {
  const terminalBefore = new Date(now.getTime() - TERMINAL_TOKEN_RETENTION_MS);
  const completedOutboxBefore = new Date(now.getTime() - COMPLETED_OUTBOX_RETENTION_MS);
  await database.$transaction([
    database.$executeRaw`
      DELETE FROM identity.sessions WHERE id IN (
        SELECT id FROM identity.sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at <= ${completedOutboxBefore})
           OR (expires_at <= ${completedOutboxBefore})
        ORDER BY expires_at, id LIMIT 1000
      )
    `,
    database.authToken.deleteMany({
      where: {
        OR: [
          { consumedAt: { lte: terminalBefore } },
          { consumedAt: null, expiresAt: { lte: terminalBefore } },
        ],
      },
    }),
    database.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: now } } }),
    database.$executeRaw`
      DELETE FROM platform.outbox_events AS event
      WHERE event.occurred_at <= ${completedOutboxBefore}
        AND NOT EXISTS (
          SELECT 1
          FROM platform.outbox_deliveries AS delivery
          WHERE delivery.event_id = event.id
            AND delivery.state <> 'completed'
        )
    `,
  ]);
}
