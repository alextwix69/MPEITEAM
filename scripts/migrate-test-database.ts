import { spawn } from 'node:child_process';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://komanda:komanda@127.0.0.1:55432/komanda_test?schema=public&connection_limit=2&pool_timeout=3';
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Скрипт миграции должен запускаться через pnpm.');

const child = spawn(
  process.execPath,
  [
    pnpmCli,
    '--filter',
    '@komanda/backend',
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--schema',
    'prisma/schema.prisma',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
