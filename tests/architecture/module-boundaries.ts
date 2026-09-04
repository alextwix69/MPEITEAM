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

function moduleLayer(path: string): string | undefined {
  return path
    .replaceAll('\\', '/')
    .match(/(?:^|\/)modules\/[^/]+\/(domain|application)(?:\/|$)/)?.[1];
}

function isProviderSdk(imported: string): boolean {
  return [
    '@aws-sdk/',
    '@azure/',
    '@google-cloud/',
    'bullmq',
    'ioredis',
    'minio',
    'nodemailer',
    'pg',
    'socket.io',
  ].some((provider) => imported === provider || imported.startsWith(provider));
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

export function findBoundaryViolations(inputs: SourceInput[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const graph = new Map<string, Set<string>>();

  for (const input of inputs) {
    const owner = moduleName(input.path);
    if (!owner) continue;
    const layer = moduleLayer(input.path);
    const sourceFile = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true);

    for (const rawImport of moduleSpecifiers(sourceFile)) {
      const imported = rawImport.replaceAll('\\', '/');
      if ((layer === 'application' || layer === 'domain') && isProviderSdk(imported)) {
        violations.push({
          file: input.path,
          imported,
          reason: `Слой ${layer} не должен напрямую импортировать provider SDK.`,
        });
      }
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

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const visit = (source: string): void => {
    visited.add(source);
    active.add(source);
    stack.push(source);
    for (const target of graph.get(source) ?? []) {
      if (!visited.has(target)) {
        visit(target);
      } else if (active.has(target)) {
        const cycleStart = stack.indexOf(target);
        const cycle = [...stack.slice(cycleStart), target];
        const cycleKey = [...new Set(cycle)].sort().join('|');
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          violations.push({
            file: source,
            imported: target,
            reason: `Обнаружен цикл между модулями: ${cycle.join(' -> ')}.`,
          });
        }
      }
    }
    stack.pop();
    active.delete(source);
  };

  const modules = new Set([...graph.keys(), ...[...graph.values()].flatMap((items) => [...items])]);
  for (const module of modules) {
    if (!visited.has(module)) visit(module);
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
