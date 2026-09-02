import { describe, expect, it } from 'vitest';
import { createProblemDetails } from '../../src/platform/http/problem-details';
import { sanitizeLogMessage } from '../../src/platform/observability/json-logger';

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
});
