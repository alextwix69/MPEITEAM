import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '../../src/platform/config/env.schema';
import {
  checkFoundationMigration,
  probeDatabaseUrl,
  SingleFlight,
  within,
} from '../../src/platform/health/runtime-dependencies';

describe('runtime dependency safeguards', () => {
  it.each([
    [true, true],
    [false, false],
  ])('requires the expected completed migration: %s', async (applied, expected) => {
    const prisma = {
      $queryRaw: vi.fn(async () => [{ applied }]),
    } as unknown as Pick<PrismaClient, '$queryRaw'>;

    await expect(checkFoundationMigration(prisma, 500)).resolves.toBe(expected);
  });

  it('invokes transport cancellation when a dependency times out', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = new Promise<never>(() => undefined);
    const result = within(pending, 500, cancel);
    const rejection = expect(result).rejects.toThrow('DEPENDENCY_TIMEOUT');

    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('shares an in-flight dependency probe across concurrent readiness requests', async () => {
    const singleFlight = new SingleFlight();
    let resolveProbe: ((value: string) => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const first = singleFlight.run('postgres', operation);
    const second = singleFlight.run('postgres', operation);
    await Promise.resolve();
    resolveProbe?.('up');

    await expect(Promise.all([first, second])).resolves.toEqual(['up', 'up']);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('bounds the database transport behind a readiness timeout', () => {
    const environment = {
      DEPENDENCY_TIMEOUT_MS: 1500,
      API_DATABASE_URL:
        'postgresql://user:pass@db:5432/app?schema=public&connection_limit=5&pool_timeout=9',
    } as ApiEnvironment;
    const url = new URL(probeDatabaseUrl(environment));

    expect(url.searchParams.get('connection_limit')).toBe('5');
    expect(url.searchParams.get('connect_timeout')).toBe('2');
    expect(url.searchParams.get('pool_timeout')).toBe('2');
    expect(url.searchParams.get('socket_timeout')).toBe('2');
    expect(url.searchParams.get('statement_timeout')).toBe('1500');
  });
});
