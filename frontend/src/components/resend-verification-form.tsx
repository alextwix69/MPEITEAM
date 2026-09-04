'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api/client';
import { prepareIdempotencyAttempt, type PendingIdempotencyAttempt } from '../lib/idempotency';

export function ResendVerificationForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [pendingAttempt, setPendingAttempt] = useState<PendingIdempotencyAttempt>();

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(
      () => setCooldownSeconds((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);

  async function resend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setMessage('Укажите электронную почту.');
      return;
    }
    setPending(true);
    setMessage(undefined);
    const body = { email: normalizedEmail };
    const attempt = prepareIdempotencyAttempt(pendingAttempt, body);
    setPendingAttempt(attempt);
    try {
      const result = await apiClient.POST('/auth/email-verifications/resend', {
        params: { header: { 'Idempotency-Key': attempt.key } },
        body,
      });
      if (result.error) {
        if (!result.error.error?.retryable) setPendingAttempt(undefined);
        const retryAfter = result.response.headers.get('Retry-After');
        if (retryAfter) setCooldownSeconds(Math.max(0, Number(retryAfter)));
        setMessage(
          result.error.error?.message ?? 'Не удалось отправить запрос. Повторите попытку позже.',
        );
      } else {
        setPendingAttempt(undefined);
        setCooldownSeconds(60);
        setMessage(
          'Если аккаунт существует и ожидает подтверждения, новое письмо поставлено в очередь.',
        );
      }
    } catch {
      setMessage('Связь прервалась. Повторите тот же запрос.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mt-8" onSubmit={resend}>
      <label className="block font-medium" htmlFor="resend-email">
        Не получили письмо?
      </label>
      <input
        className="mt-2 w-full rounded-lg border border-[var(--border)] bg-white p-3"
        id="resend-email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="name@mpei.ru"
        required
        type="email"
        value={email}
      />
      <button
        className="mt-3 rounded-lg bg-[var(--accent)] px-4 py-2 font-semibold text-white disabled:opacity-60"
        disabled={pending || cooldownSeconds > 0}
        type="submit"
      >
        {cooldownSeconds > 0 ? `Повторить через ${cooldownSeconds} с` : 'Отправить повторно'}
      </button>
      {message && (
        <p className="mt-4" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
