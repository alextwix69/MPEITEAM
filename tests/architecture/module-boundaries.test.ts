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

  it('keeps current module shells public and free of business stubs', () => {
    const inputs = readModuleSources(repositoryRoot);
    expect(findBoundaryViolations(inputs)).toEqual([]);
    expect(inputs).toHaveLength(13);
    expect(
      inputs.every(
        ({ path, source }) => path.endsWith('/index.ts') && source.trim() === 'export {};',
      ),
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
