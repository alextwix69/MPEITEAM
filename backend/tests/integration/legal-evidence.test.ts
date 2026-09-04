import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { LegalEvidenceStore } from '../../src/modules/compliance';
import { parseWorkerEnvironment } from '../../src/platform/config/env.schema';

const legalDatabaseUrl =
  process.env.TEST_LEGAL_DATABASE_URL ??
  'postgresql://komanda_legal:komanda-legal-local@127.0.0.1:55432/komanda_legal_test?schema=public&connection_limit=2';
const environment = parseWorkerEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
  WORKER_DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2',
  LEGAL_DATABASE_URL: legalDatabaseUrl,
  LEGAL_SUBJECT_HMAC_KEY: 'integration-legal-subject-key-00001',
});

let store: LegalEvidenceStore;
let pool: Pool;

beforeAll(() => {
  store = new LegalEvidenceStore(environment);
  pool = new Pool({ connectionString: legalDatabaseUrl, max: 1 });
});

beforeEach(async () => {
  await pool.query('DELETE FROM legal.consent_evidence');
});

afterAll(async () => {
  await Promise.all([store.onApplicationShutdown(), pool.end()]);
});

describe('legal consent evidence', () => {
  it('deduplicates by source event and purges only at the retention deadline', async () => {
    const sourceEventId = uuidv7();
    const event = {
      id: sourceEventId,
      aggregateId: uuidv7(),
      payload: {
        documentType: 'age_18',
        documentVersion: 'local-v1',
        occurredAt: '2026-09-04T09:00:00.000Z',
      },
    };
    await store.appendConsentEvidence(event);
    await store.appendConsentEvidence(event);
    const before = await pool.query<{
      count: string;
      subject_token: Buffer;
      retention_until: Date;
    }>(
      `SELECT COUNT(*) OVER ()::text AS count, subject_token, retention_until
       FROM legal.consent_evidence WHERE source_event_id = $1`,
      [sourceEventId],
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]!.count).toBe('1');
    expect(before.rows[0]!.subject_token.toString('utf8')).not.toContain(event.aggregateId);

    await expect(store.purgeExpired(new Date('2029-09-03T23:59:59.000Z'))).resolves.toBe(0);
    await expect(store.purgeExpired(new Date('2029-09-04T09:00:00.000Z'))).resolves.toBe(1);
  });

  it('uses PostgreSQL calendar arithmetic for a leap-day retention deadline', async () => {
    const sourceEventId = uuidv7();
    await store.appendConsentEvidence({
      id: sourceEventId,
      aggregateId: uuidv7(),
      payload: {
        documentType: 'personal_data',
        documentVersion: 'local-v1',
        occurredAt: '2028-02-29T12:00:00.000Z',
      },
    });
    const result = await pool.query<{ retention_until: Date }>(
      'SELECT retention_until FROM legal.consent_evidence WHERE source_event_id = $1',
      [sourceEventId],
    );
    expect(result.rows[0]!.retention_until.toISOString()).toBe('2031-02-28T12:00:00.000Z');
  });
});
