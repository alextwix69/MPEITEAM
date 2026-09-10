import type { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { DatabaseService } from '../database/database.service';
import { ApplicationError } from '../http/application-error';
import { canonicalJson, sha256 } from '../security/crypto';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface CommandValue<T> {
  body: T;
  responseRefType: string;
  responseRefId: string;
  status: number;
}

interface StoredRecord {
  requestHash: Uint8Array;
  state: string;
  responseStatus: number | null;
  responseBody: Prisma.JsonValue | null;
}

function replay<T>(record: StoredRecord, requestHash: Buffer): T {
  if (!Buffer.from(record.requestHash).equals(requestHash)) {
    throw new ApplicationError(
      'IDEMPOTENCY_KEY_REUSED',
      'Этот ключ повтора уже использован с другими данными.',
      409,
    );
  }
  if (
    record.state !== 'completed' ||
    record.responseStatus === null ||
    record.responseBody === null
  ) {
    throw new ApplicationError(
      'IDEMPOTENCY_IN_PROGRESS',
      'Предыдущий запрос ещё выполняется. Повторите позже.',
      409,
      true,
      undefined,
      undefined,
      1,
    );
  }
  return record.responseBody as T;
}

export async function runIdempotentCommand<T>(
  database: DatabaseService,
  accountId: string,
  route: string,
  key: string,
  requestBody: unknown,
  command: (transaction: Prisma.TransactionClient) => Promise<CommandValue<T>>,
): Promise<{ body: T; replayed: boolean; status: number }> {
  const requestHash = sha256(canonicalJson(requestBody));
  const existing = await database.idempotencyRecord.findFirst({
    where: { actorAccountId: accountId, route, key, expiresAt: { gt: new Date() } },
  });
  if (existing) {
    return {
      body: replay<T>(existing, requestHash),
      replayed: true,
      status: existing.responseStatus!,
    };
  }

  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      DELETE FROM platform.idempotency_records
      WHERE actor_account_id = ${accountId}::uuid AND route = ${route} AND key = ${key} AND expires_at <= now()
    `;
    const id = uuidv7();
    const inserted = await transaction.$executeRaw`
      INSERT INTO platform.idempotency_records
        (id, actor_account_id, route, key, request_hash, state, expires_at)
      VALUES
        (${id}::uuid, ${accountId}::uuid, ${route}, ${key}, ${requestHash}, 'in_progress', ${new Date(Date.now() + IDEMPOTENCY_TTL_MS)})
      ON CONFLICT (actor_account_id, route, key) WHERE actor_account_id IS NOT NULL DO NOTHING
    `;
    if (inserted !== 1) {
      const concurrent = await transaction.idempotencyRecord.findFirst({
        where: { actorAccountId: accountId, route, key, expiresAt: { gt: new Date() } },
      });
      if (!concurrent) {
        throw new ApplicationError('IDEMPOTENCY_IN_PROGRESS', 'Повторите запрос позже.', 409, true);
      }
      return {
        body: replay<T>(concurrent, requestHash),
        replayed: true,
        status: concurrent.responseStatus!,
      };
    }

    const value = await command(transaction);
    await transaction.idempotencyRecord.update({
      where: { id },
      data: {
        state: 'completed',
        responseStatus: value.status,
        responseRefType: value.responseRefType,
        responseRefId: value.responseRefId,
        responseBody: value.body as Prisma.InputJsonValue,
      },
    });
    return { body: value.body, replayed: false, status: value.status };
  });
}
