import { spawn } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Скрипт миграции должен запускаться через pnpm.');

const mainDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://komanda_admin:komanda-admin-local@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2&pool_timeout=3';
const legalDatabaseUrl =
  process.env.TEST_LEGAL_DATABASE_URL ??
  'postgresql://komanda_legal:komanda-legal-local@127.0.0.1:55432/komanda_legal_test?schema=public&connection_limit=2&pool_timeout=3';

function migrate(schema: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        pnpmCli!,
        '--filter',
        '@komanda/backend',
        'exec',
        'prisma',
        'migrate',
        'deploy',
        '--schema',
        schema,
      ],
      { stdio: 'inherit', env: environment },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Migration failed with exit code ${code ?? 1}`)),
    );
  });
}

async function main(): Promise<void> {
  await migrate('prisma/schema.prisma', { ...process.env, DATABASE_URL: mainDatabaseUrl });
  await migrate('prisma/legal/schema.prisma', {
    ...process.env,
    LEGAL_DATABASE_URL: legalDatabaseUrl,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
