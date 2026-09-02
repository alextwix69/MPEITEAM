import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { trace } from '@opentelemetry/api';
import { validate as validateUuid, v7 as uuidv7 } from 'uuid';
import type { JsonLogger } from '../observability/json-logger';

export interface RequestContextValue {
  requestId: string;
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContextValue>();
const tracer = trace.getTracer('komanda-mpei-api');

function resolveRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && validateUuid(candidate) ? candidate : uuidv7();
}

export function getRequestContext(): RequestContextValue | undefined {
  return storage.getStore();
}

export function requestContextMiddleware(logger: JsonLogger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(request.headers['x-request-id']);
    const context = { requestId, correlationId: requestId };
    const startedAt = performance.now();
    const span = tracer.startSpan('http.request');

    response.setHeader('X-Request-Id', requestId);
    response.on('finish', () => {
      const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const route = request.route?.path ?? 'unmatched';
      logger.child(context).info({
        module: 'platform',
        operation: `${request.method} ${String(route)}`,
        result: response.statusCode,
        latencyMs,
      });
      span.setAttributes({
        'http.request.method': request.method,
        'http.response.status_code': response.statusCode,
      });
      span.end();
    });

    storage.run(context, next);
  };
}

export { resolveRequestId };
