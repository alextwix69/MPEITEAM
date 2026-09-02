import { PrismaClient } from '@prisma/client';
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

beforeAll(() => {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://komanda:komanda@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2';
  prisma = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await prisma.$disconnect();
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

  it('does not create speculative business tables', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_schema: string; table_name: string }>>`
      SELECT table_schema, table_name FROM information_schema.tables
    `;
    expect(tables.filter(({ table_schema }) => domainSchemas.includes(table_schema))).toEqual([]);
  });
});
