import { z } from 'zod';

const componentStatusSchema = z.enum(['up', 'down']);

export const readinessSchema = z.object({
  status: z.enum(['ready', 'degraded', 'unavailable']),
  checkedAt: z.string().datetime(),
  dependencies: z.object({
    postgres: z.object({ status: componentStatusSchema }),
    redis: z.object({ status: componentStatusSchema }),
    objectStorage: z.object({ status: componentStatusSchema }),
    worker: z.object({ status: componentStatusSchema }),
  }),
});

export type Readiness = z.infer<typeof readinessSchema>;

export interface HealthPresentation {
  label: string;
  description: string;
  tone: 'success' | 'warning' | 'danger';
}

export function toHealthPresentation(status: Readiness['status'] | string): HealthPresentation {
  if (status === 'ready') {
    return {
      label: 'Сервис готов',
      description: 'Все технические компоненты доступны.',
      tone: 'success',
    };
  }
  if (status === 'degraded') {
    return {
      label: 'Сервис работает с ограничениями',
      description: 'Некоторые фоновые или вспомогательные компоненты временно недоступны.',
      tone: 'warning',
    };
  }
  return {
    label: 'Сервис временно недоступен',
    description: 'Повторите попытку через несколько минут.',
    tone: 'danger',
  };
}

export async function fetchReadiness(signal?: AbortSignal): Promise<Readiness> {
  const timeoutSignal = AbortSignal.timeout(4000);
  const response = await fetch('/health/ready', {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  const body: unknown = await response.json();
  const readiness = readinessSchema.parse(body);
  if (!response.ok && readiness.status !== 'unavailable') {
    throw new Error('Некорректный ответ проверки готовности.');
  }
  return readiness;
}
