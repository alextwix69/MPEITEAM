'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchReadiness, toHealthPresentation } from '../lib/api/health';
import { Button } from './ui/button';

const toneClass = {
  success: 'border-emerald-200 bg-emerald-50 text-[var(--success)]',
  warning: 'border-amber-200 bg-amber-50 text-[var(--warning)]',
  danger: 'border-red-200 bg-red-50 text-[var(--danger)]',
} as const;

export function HealthPanel() {
  const query = useQuery({
    queryKey: ['platform-readiness'],
    queryFn: ({ signal }) => fetchReadiness(signal),
  });

  if (query.isPending) {
    return (
      <div
        className="mt-10 rounded-2xl border border-[var(--border)] bg-slate-50 p-5"
        role="status"
      >
        Проверяем состояние сервиса…
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="mt-10 rounded-2xl border border-red-200 bg-red-50 p-5" role="alert">
        <p className="font-semibold text-[var(--danger)]">Не удалось проверить состояние сервиса</p>
        <p className="mt-1 text-sm text-slate-700">Проверьте соединение и повторите попытку.</p>
        <Button className="mt-4" onClick={() => void query.refetch()}>
          Повторить
        </Button>
      </div>
    );
  }

  const presentation = toHealthPresentation(query.data.status);
  return (
    <div className={`mt-10 rounded-2xl border p-5 ${toneClass[presentation.tone]}`} role="status">
      <p className="font-semibold">{presentation.label}</p>
      <p className="mt-1 text-sm text-slate-700">{presentation.description}</p>
      {query.data.status !== 'ready' && (
        <Button className="mt-4" variant="secondary" onClick={() => void query.refetch()}>
          Повторить
        </Button>
      )}
    </div>
  );
}
