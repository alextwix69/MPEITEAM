import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const domainSchemas = [
  'identity',
  'catalog',
  'profiles',
  'opportunities',
  'recruitment',
  'teams',
  'scheduling',
  'messaging',
  'trust',
  'notifications',
  'files',
  'search',
  'compliance',
  'platform',
];

let prisma: PrismaClient;
let legal: Pool;
let apiDatabase: Pool;

beforeAll(() => {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2';
  prisma = new PrismaClient({ datasources: { db: { url } } });
  legal = new Pool({
    connectionString:
      process.env.TEST_LEGAL_DATABASE_URL ??
      'postgresql://komanda_legal:komanda-legal-local@127.0.0.1:55432/komanda_legal_test?schema=public&connection_limit=2',
  });
  apiDatabase = new Pool({
    connectionString:
      process.env.TEST_API_DATABASE_URL ??
      'postgresql://komanda_api:komanda-api-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2',
  });
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), legal.end(), apiDatabase.end()]);
});

describe('platform foundation migration', () => {
  it('enables pg_trgm and creates every owned schema', async () => {
    const extensions = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    const schemas = await prisma.$queryRaw<Array<{ schema_name: string }>>`
      SELECT schema_name FROM information_schema.schemata
    `;

    expect(extensions).toEqual([{ extname: 'pg_trgm' }]);
    expect(
      schemas
        .map(({ schema_name }) => schema_name)
        .filter((schema) => domainSchemas.includes(schema))
        .sort(),
    ).toEqual([...domainSchemas].sort());
  });

  it('creates only the business tables required by registration', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_schema: string; table_name: string }>>`
      SELECT table_schema, table_name FROM information_schema.tables
    `;
    expect(
      tables
        .filter(({ table_schema }) => domainSchemas.includes(table_schema))
        .map(({ table_schema, table_name }) => `${table_schema}.${table_name}`)
        .sort(),
    ).toEqual(
      [
        'identity.accounts',
        'identity.auth_tokens',
        'identity.consent_statuses',
        'identity.credentials',
        'identity.sessions',
        'platform.idempotency_records',
        'platform.outbox_deliveries',
        'platform.outbox_events',
        'profiles.profile_versions',
        'profiles.profiles',
        'profiles.resumes',
      ].sort(),
    );
  });

  it('keeps consent evidence in the isolated legal database', async () => {
    const result = await legal.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'legal'`,
    );
    expect(result.rows).toEqual([{ table_name: 'consent_evidence' }]);
  });

  it('runs the API as a non-superuser without access to the legal database', async () => {
    const migrations = await apiDatabase.query(
      'SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    expect(migrations.rows.length).toBeGreaterThanOrEqual(3);
    await expect(apiDatabase.query('SELECT logs FROM public._prisma_migrations')).rejects.toThrow(
      /permission denied/u,
    );
    const role = await apiDatabase.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(role.rows).toEqual([{ rolsuper: false }]);

    const legalUrl = new URL(
      process.env.TEST_LEGAL_DATABASE_URL ??
        'postgresql://komanda_legal:komanda-legal-local@127.0.0.1:55432/komanda_legal_test',
    );
    legalUrl.username = 'komanda_api';
    legalUrl.password = 'komanda-api-local';
    const forbidden = new Pool({ connectionString: legalUrl.toString(), max: 1 });
    await expect(forbidden.query('SELECT 1')).rejects.toThrow(/permission denied for database/u);
    await forbidden.end().catch(() => undefined);
  });
});
