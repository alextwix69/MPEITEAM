import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { decryptSecret, sha256 } from '../../../platform/security/crypto';
import type { EmailSender } from '../application/email-sender.port';

const payloadSchema = z.object({ encryptedToken: z.string().base64() }).strict();

// Worker calls Identity's public contract; token/account data stays inside Identity.
export async function deliverPasswordReset(
  database: PrismaClient,
  sender: EmailSender,
  encryptionKey: string,
  appUrl: string,
  event: { id: string; aggregateId: string; payload: unknown },
): Promise<void> {
  const payload = payloadSchema.parse(event.payload);
  const secret = decryptSecret(encryptionKey, Buffer.from(payload.encryptedToken, 'base64'));
  const token = await database.authToken.findUnique({
    where: { tokenHash: Uint8Array.from(sha256(secret)) },
    include: { account: true },
  });
  if (
    !token ||
    token.accountId !== event.aggregateId ||
    token.purpose !== 'password_reset' ||
    token.consumedAt ||
    token.expiresAt <= new Date() ||
    !['active', 'unverified'].includes(token.account.state)
  )
    return;
  const url = new URL('/reset-password', appUrl);
  url.searchParams.set('token', secret);
  await sender.sendPasswordResetEmail({
    eventId: event.id,
    recipient: token.account.emailNormalized,
    resetUrl: url.toString(),
  });
}
