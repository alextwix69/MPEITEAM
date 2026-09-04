import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  createProblemDetails,
  ProblemDetailsFilter,
  safeExceptionMetadata,
} from '../../src/platform/http/problem-details';
import { type JsonLogger, sanitizeLogMessage } from '../../src/platform/observability/json-logger';

describe('safe errors and logging', () => {
  it('creates the stable Russian error envelope', () => {
    expect(createProblemDetails('INVALID_REQUEST', 'Проверьте данные.', 'request-id')).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Проверьте данные.',
        requestId: 'request-id',
        retryable: false,
      },
    });
  });

  it('redacts connection URLs from log messages', () => {
    const message = sanitizeLogMessage(
      'Failure at postgresql://user:secret@db:5432/app and redis://redis:6379',
    );
    expect(message).not.toContain('secret');
    expect(message).not.toContain('redis:6379');
    expect(message).toBe('Failure at [REDACTED_URL] and [REDACTED_URL]');
  });

  it('does not derive telemetry metadata from an exception message', () => {
    const secret = 'user@mpei.ru bearer-secret private message';
    const metadata = safeExceptionMetadata(new Error(secret));

    expect(metadata).toEqual({ exceptionType: 'Error' });
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(JSON.stringify(metadata)).not.toContain('mpei.ru');
  });

  it('does not pass a thrown message or credentials to the operational logger', () => {
    const loggedError = vi.fn();
    const child = vi.fn(() => ({ error: loggedError }));
    const logger = { child } as unknown as JsonLogger;
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(),
      type: vi.fn(),
      send: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const secret = 'user@mpei.ru Bearer token-123 private-message password=hunter2';

    new ProblemDetailsFilter(logger).catch(new Error(secret), host);

    const logInvocation = JSON.stringify({
      bindings: child.mock.calls,
      messages: loggedError.mock.calls,
    });
    expect(logInvocation).not.toContain(secret);
    expect(logInvocation).not.toContain('mpei.ru');
    expect(logInvocation).not.toContain('hunter2');
    expect(loggedError).toHaveBeenCalledWith('HTTP request failed.');
  });
});
