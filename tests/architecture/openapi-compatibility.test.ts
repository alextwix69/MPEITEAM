import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { compareOpenApi } from '../../scripts/check-openapi-compatibility';

const temporaryDirectories: string[] = [];

async function specifications(modifiedPaths: Record<string, unknown>): Promise<[string, string]> {
  const directory = await mkdtemp(join(tmpdir(), 'komanda-openapi-'));
  temporaryDirectories.push(directory);
  const original = join(directory, 'original.json');
  const modified = join(directory, 'modified.json');
  const document = (paths: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'test', version: '1.0.0' },
    paths,
  });
  const operation = {
    get: { operationId: 'getHealth', responses: { 200: { description: 'ok' } } },
  };

  await writeFile(original, JSON.stringify(document({ '/health': operation })), 'utf8');
  await writeFile(modified, JSON.stringify(document(modifiedPaths)), 'utf8');
  return [original, modified];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('OpenAPI release compatibility', () => {
  it('rejects removal of an existing path', async () => {
    const [original, modified] = await specifications({});
    await expect(compareOpenApi(original, modified)).resolves.toMatchObject({ breaking: true });
  });

  it('allows an additive optional endpoint', async () => {
    const operation = {
      get: { operationId: 'getVersion', responses: { 200: { description: 'ok' } } },
    };
    const [original, modified] = await specifications({
      '/health': {
        get: { operationId: 'getHealth', responses: { 200: { description: 'ok' } } },
      },
      '/version': operation,
    });
    await expect(compareOpenApi(original, modified)).resolves.toMatchObject({ breaking: false });
  });
});
