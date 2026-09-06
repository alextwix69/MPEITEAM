import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('komanda-mpei-outbox');
const backlog = meter.createGauge('outbox.delivery.backlog');
const oldestPendingAge = meter.createGauge('outbox.delivery.oldest_pending_age', { unit: 'ms' });
const consumers = [
  'identity.verification-email',
  'identity.password-reset-email',
  'compliance.consent-evidence',
] as const;
const states = ['pending', 'leased', 'dead_letter'] as const;

export interface OutboxMetricRow {
  consumer: string;
  state: string;
  count: bigint | number;
  ageMs: number | null;
}

export function recordOutboxSnapshot(rows: OutboxMetricRow[]): void {
  for (const consumer of consumers) {
    const deliveries = rows.filter((row) => row.consumer === consumer);
    for (const state of states) {
      backlog.record(Number(deliveries.find((row) => row.state === state)?.count ?? 0), {
        consumer,
        state,
      });
    }
    oldestPendingAge.record(
      Math.max(
        0,
        ...deliveries
          .filter((row) => row.state !== 'dead_letter')
          .map((row) => Number(row.ageMs ?? 0)),
      ),
      { consumer },
    );
  }
}
