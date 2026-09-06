import { afterEach, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MetricsRuntime } from '../../src/platform/observability/metrics-runtime';

let runtime: MetricsRuntime | undefined;
const options = { METRICS_HOST: '127.0.0.1', METRICS_PORT: 0, OTEL_SERVICE_NAME: 'komanda-test' };

afterEach(async () => {
  await runtime?.onApplicationShutdown();
  runtime = undefined;
});

describe('runtime metrics export', () => {
  it('exports real Identity instruments after SDK startup and drops sensitive attributes', async () => {
    runtime = await MetricsRuntime.start(options, 'api');
    // The same import order as main.ts: no Identity instrument may be created before the SDK.
    const { IdentityService } =
      await import('../../src/modules/identity/application/identity.service');
    const identity = Object.create(IdentityService.prototype) as InstanceType<
      typeof IdentityService
    >;
    identity.recordAuthResult('login', 'completed');
    identity.recordAuthResult('reset_request', 'failed');
    metrics.getMeter('komanda-mpei-identity').createCounter('identity.csrf.failures').add(1, {
      email: 'secret@example.invalid',
      token: 'do-not-export',
      cookie: 'do-not-export',
      url: 'https://private.invalid/reset-password',
    });
    const response = await fetch(`http://127.0.0.1:${runtime.port}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/identity_auth_commands_total\{[^\n]*operation="login"[^\n]*\} 1/u);
    expect(body).toMatch(
      /identity_auth_commands_total\{[^\n]*operation="reset_request"[^\n]*\} 1/u,
    );
    expect(body).toContain('identity_csrf_failures_total');
    expect(body).toContain('process_role="api"');
    expect(body).not.toMatch(/secret@example|do-not-export|private\.invalid/u);
    expect((await fetch(`http://127.0.0.1:${runtime.port}/other`)).status).toBe(404);
  });

  it('exports worker backlog and clears age/DLQ gauges after recovery', async () => {
    runtime = await MetricsRuntime.start(options, 'worker');
    const { recordOutboxSnapshot } = await import('../../src/worker/outbox-metrics');
    const consumer = 'identity.password-reset-email';
    recordOutboxSnapshot([
      { consumer, state: 'pending', count: 2n, ageMs: 360_000 },
      { consumer, state: 'dead_letter', count: 1n, ageMs: 500_000 },
    ]);
    const url = `http://127.0.0.1:${runtime.port}/metrics`;
    const delayed = await (await fetch(url)).text();
    expect(delayed).toMatch(
      /outbox_delivery_oldest_pending_age\{[^\n]*consumer="identity.password-reset-email"[^\n]*\} 360000/u,
    );
    expect(delayed).toMatch(/outbox_delivery_backlog\{[^\n]*state="dead_letter"[^\n]*\} 1/u);
    recordOutboxSnapshot([]);
    const recovered = await (await fetch(url)).text();
    expect(recovered).toMatch(
      /outbox_delivery_oldest_pending_age\{[^\n]*consumer="identity.password-reset-email"[^\n]*\} 0/u,
    );
    expect(recovered).not.toMatch(/outbox_delivery_backlog\{[^\n]*\} [1-9]/u);
    await runtime.onApplicationShutdown();
    runtime = undefined;
    await expect(fetch(url)).rejects.toThrow();
  });

  it('reports a safe startup error when the private scrape port is occupied', async () => {
    runtime = await MetricsRuntime.start(options, 'api');
    await expect(
      MetricsRuntime.start({ ...options, METRICS_PORT: runtime.port }, 'worker'),
    ).rejects.toThrow('METRICS_START_FAILED');
    expect((await fetch(`http://127.0.0.1:${runtime.port}/metrics`)).status).toBe(200);
    expect(metrics.getMeterProvider()).not.toBeUndefined();
  });
});
