import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CompatibilityResult {
  breaking: boolean;
  report: unknown;
}

function containsBreakingChange(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsBreakingChange);
  if (!value || typeof value !== 'object') return false;

  for (const [key, nested] of Object.entries(value)) {
    if (key === 'breaking' && nested === true) return true;
    if (key === 'breakingChanges' && typeof nested === 'number' && nested > 0) return true;
    if (containsBreakingChange(nested)) return true;
  }
  return false;
}

export async function compareOpenApi(
  originalPath: string,
  modifiedPath: string,
): Promise<CompatibilityResult> {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error('Проверка совместимости должна запускаться через pnpm.');

  const reportText = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        pnpmCli,
        '--filter',
        '@komanda/openapi-compatibility',
        'exec',
        'openapi-changes',
        'report',
        '--reproducible',
        '--no-logo',
        resolvePath(originalPath),
        resolvePath(modifiedPath),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(stderr.trim() || `openapi-changes завершился с кодом ${String(code)}.`));
    });
  });

  const report: unknown = JSON.parse(reportText);
  return { breaking: containsBreakingChange(report), report };
}

async function main(): Promise<void> {
  const result = await compareOpenApi('api/openapi.release.yaml', 'api/openapi.yaml');
  if (result.breaking) {
    process.stderr.write(`${JSON.stringify(result.report, null, 2)}\n`);
    throw new Error('Обнаружено несовместимое изменение OpenAPI-контракта.');
  }
  process.stdout.write('Breaking changes OpenAPI не обнаружены.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
