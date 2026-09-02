import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

interface OpenApiOperation {
  operationId?: unknown;
}

interface OpenApiDocument {
  openapi?: unknown;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

async function main(): Promise<void> {
  const document = parse(await readFile('api/openapi.yaml', 'utf8')) as OpenApiDocument;

  if (document.openapi !== '3.1.0') {
    throw new Error('api/openapi.yaml должен использовать OpenAPI 3.1.0.');
  }

  const operationIds = new Map<string, string>();

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
        throw new Error(`${method.toUpperCase()} ${path}: отсутствует operationId.`);
      }
      const previous = operationIds.get(operation.operationId);
      if (previous) {
        throw new Error(
          `operationId ${operation.operationId} повторяется: ${previous} и ${method.toUpperCase()} ${path}.`,
        );
      }
      operationIds.set(operation.operationId, `${method.toUpperCase()} ${path}`);
    }
  }

  if (operationIds.size === 0) {
    throw new Error('OpenAPI не содержит операций.');
  }

  process.stdout.write(`Проверено operationId: ${operationIds.size}.\n`);
}

void main();
