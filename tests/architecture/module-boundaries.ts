import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface SourceInput {
  path: string;
  source: string;
}

export interface BoundaryViolation {
  file: string;
  imported: string;
  reason: string;
}

function moduleName(path: string): string | undefined {
  return path.replaceAll('\\', '/').match(/(?:^|\/)modules\/([^/]+)\//)?.[1];
}

export function findBoundaryViolations(inputs: SourceInput[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const graph = new Map<string, Set<string>>();

  for (const input of inputs) {
    const owner = moduleName(input.path);
    if (!owner) continue;
    const sourceFile = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true);

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const imported = statement.moduleSpecifier.text.replaceAll('\\', '/');
      const resolvedImport = imported.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(input.path.replaceAll('\\', '/')), imported))
        : imported;
      const target = resolvedImport.match(/modules\/([^/]+)(?:\/(.*))?$/);
      if (!target || target[1] === owner) continue;

      const targetName = target[1];
      const internalPath = target[2];
      graph.set(owner, (graph.get(owner) ?? new Set()).add(targetName));
      if (internalPath && internalPath !== 'index' && internalPath !== 'index.ts') {
        violations.push({
          file: input.path,
          imported,
          reason: `Модуль ${owner} импортирует внутреннюю реализацию модуля ${targetName}.`,
        });
      }
      if (/\/(?:infrastructure|repositories?)(?:\/|$)/u.test(resolvedImport)) {
        violations.push({
          file: input.path,
          imported,
          reason: 'Запрещён прямой импорт infrastructure/repository другого модуля.',
        });
      }
    }
  }

  for (const [source, targets] of graph) {
    for (const target of targets) {
      if (graph.get(target)?.has(source)) {
        violations.push({
          file: source,
          imported: target,
          reason: 'Обнаружен цикл между модулями.',
        });
      }
    }
  }

  return violations;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

export function readModuleSources(repositoryRoot: string): SourceInput[] {
  const root = resolve(repositoryRoot, 'backend', 'src', 'modules');
  return sourceFiles(root).map((path) => ({
    path: relative(repositoryRoot, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}
