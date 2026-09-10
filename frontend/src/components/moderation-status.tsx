import type { components } from '../lib/api/generated';

type Moderation = components['schemas']['ModerationStatus'];

export function ModerationStatus({ moderation }: { moderation?: Moderation }) {
  if (!moderation || moderation.state === 'not_submitted') return null;
  const labels: Record<Moderation['state'], string> = {
    not_submitted: 'Ещё не отправлено на проверку',
    pending: 'Проверяется. До одобрения изменения видны только вам.',
    approved: 'Одобрено и опубликовано.',
    revision_required: 'Нужно исправить материал и отправить его повторно.',
    failed: 'Проверка временно недоступна. Материал не опубликован.',
    manual_review_pending: 'Материал ожидает дополнительной проверки.',
    appeal_pending: 'Обращение рассматривается.',
  };
  return (
    <aside aria-live="polite" className="rounded-xl border border-slate-300 bg-white p-4">
      <p className="font-semibold">{labels[moderation.state]}</p>
      {moderation.reason && <p className="mt-2 text-sm">{moderation.reason}</p>}
      {moderation.violationCodes?.length ? (
        <p className="mt-2 text-sm text-slate-600">
          Правила: {moderation.violationCodes.join(', ')}
        </p>
      ) : null}
    </aside>
  );
}
