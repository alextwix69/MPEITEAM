import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBoundaryViolations, readModuleSources } from './module-boundaries';

const repositoryRoot = resolve(__dirname, '..', '..');

describe('bounded-context module boundaries', () => {
  it('allows imports through another module public index', () => {
    expect(
      findBoundaryViolations([
        {
          path: 'backend/src/modules/identity/application/example.ts',
          source: "import type { PublicType } from '../../catalog/index';",
        },
      ]),
    ).toEqual([]);
  });

  it('rejects imports of another module infrastructure', () => {
    const violations = findBoundaryViolations([
      {
        path: 'backend/src/modules/identity/application/example.ts',
        source:
          "import { CatalogRepository } from '../../catalog/infrastructure/catalog.repository';",
      },
    ]);
    expect(violations.map(({ reason }) => reason)).toContain(
      'Запрещён прямой импорт infrastructure/repository другого модуля.',
    );
  });

  it('rejects provider SDK imports from application and domain layers', () => {
    const violations = findBoundaryViolations([
      {
        path: 'backend/src/modules/files/application/upload.ts',
        source: "import { S3Client } from '@aws-sdk/client-s3';",
      },
    ]);

    expect(violations.map(({ reason }) => reason)).toContain(
      'Слой application не должен напрямую импортировать provider SDK.',
    );
  });

  it('rejects module cycles longer than two edges', () => {
    const violations = findBoundaryViolations([
      {
        path: 'backend/src/modules/identity/index.ts',
        source: "export * from '../catalog/index';",
      },
      {
        path: 'backend/src/modules/catalog/index.ts',
        source: "import '../profiles/index';",
      },
      {
        path: 'backend/src/modules/profiles/index.ts',
        source: "void import('../identity/index');",
      },
    ]);

    expect(
      violations.some(({ reason }) => reason.includes('identity -> catalog -> profiles')),
    ).toBe(true);
  });

  it('keeps module entrypoints public and untouched contexts as empty shells', () => {
    const inputs = readModuleSources(repositoryRoot);
    expect(findBoundaryViolations(inputs)).toEqual([]);
    const entrypoints = inputs.filter(({ path }) => path.endsWith('/index.ts'));
    expect(entrypoints).toHaveLength(13);
    expect(
      entrypoints
        .filter(
          ({ path }) =>
            !path.includes('/identity/') &&
            !path.includes('/profiles/') &&
            !path.includes('/compliance/'),
        )
        .every(({ source }) => source.trim() === 'export {};'),
    ).toBe(true);
    expect(readdirSync(resolve(repositoryRoot, 'backend', 'src', 'modules')).sort()).toEqual([
      'catalog',
      'compliance',
      'files',
      'identity',
      'messaging',
      'notifications',
      'opportunities',
      'profiles',
      'recruitment',
      'scheduling',
      'search',
      'teams',
      'trust',
    ]);
  });
});
