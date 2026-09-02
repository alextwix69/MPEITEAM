import { describe, expect, it } from 'vitest';
import { readinessSchema, toHealthPresentation } from '../src/lib/api/health';

describe('health presentation', () => {
  it.each([
    ['ready', 'Сервис готов', 'success'],
    ['degraded', 'Сервис работает с ограничениями', 'warning'],
    ['unavailable', 'Сервис временно недоступен', 'danger'],
    ['future-status', 'Сервис временно недоступен', 'danger'],
  ])('maps %s to a safe Russian fallback', (status, label, tone) => {
    expect(toHealthPresentation(status)).toMatchObject({ label, tone });
  });

  it('rejects an invalid external response', () => {
    expect(() => readinessSchema.parse({ status: 'ready', dependencies: {} })).toThrow();
  });
});
