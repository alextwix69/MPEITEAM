import { describe, expect, it, vi } from 'vitest';
import { HealthService } from '../../src/platform/health/health.service';
import type { ComponentStatus, DependencyProbe } from '../../src/platform/health/health.types';

function probe(
  statuses: Partial<
    Record<'postgres' | 'redis' | 'objectStorage' | 'worker', ComponentStatus>
  > = {},
): DependencyProbe {
  return {
    checkPostgres: vi.fn(async () => statuses.postgres ?? 'up'),
    checkRedis: vi.fn(async () => statuses.redis ?? 'up'),
    checkObjectStorage: vi.fn(async () => statuses.objectStorage ?? 'up'),
    checkWorkerHeartbeat: vi.fn(async () => statuses.worker ?? 'up'),
    close: vi.fn(async () => undefined),
  };
}

describe('health service', () => {
  it('does not probe dependencies for liveness', () => {
    const dependencyProbe = probe();
    expect(new HealthService(dependencyProbe).liveness()).toEqual({ status: 'ok' });
    expect(dependencyProbe.checkPostgres).not.toHaveBeenCalled();
  });

  it.each(['redis', 'objectStorage', 'worker'] as const)(
    'degrades when %s is down',
    async (name) => {
      const result = await new HealthService(probe({ [name]: 'down' })).readiness();
      expect(result.status).toBe('degraded');
      expect(result.dependencies[name].status).toBe('down');
    },
  );

  it('is unavailable only when PostgreSQL is down', async () => {
    const result = await new HealthService(probe({ postgres: 'down' })).readiness();
    expect(result.status).toBe('unavailable');
  });
});
