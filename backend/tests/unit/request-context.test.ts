import { validate, version } from 'uuid';
import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../../src/platform/http/request-context';

describe('request IDs', () => {
  it('keeps a valid caller UUID', () => {
    const requestId = '018f47a8-7b8c-7c14-a9cc-0242ac120002';
    expect(resolveRequestId(requestId)).toBe(requestId);
  });

  it.each([undefined, 'not-a-uuid'])('generates UUIDv7 for %s', (candidate) => {
    const requestId = resolveRequestId(candidate);
    expect(validate(requestId)).toBe(true);
    expect(version(requestId)).toBe(7);
  });
});
