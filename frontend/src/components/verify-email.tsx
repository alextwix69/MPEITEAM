'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../lib/api/client';
import { verificationIdempotencyKey } from '../lib/idempotency';
import { useSession } from './session-provider';

type State = 'pending' | 'success' | 'invalid' | 'waiting' | 'error';

export function VerifyEmail() {
  const { refresh } = useSession();
  const parameters = useSearchParams();
  const started = useRef(false);
  const [state, setState] = useState<State>('pending');
  const [message, setMessage] = useState('Проверяем ссылку…');

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = parameters.get('token');
    window.history.replaceState({}, '', '/verify-email');
    void verify(token);

    async function verify(secret: string | null) {
      await Promise.resolve();
      if (!secret) {
        setState('invalid');
        setMessage('В ссылке отсутствует token. Запросите новое письмо.');
        return;
      }
      try {
        const result = await apiClient.POST('/auth/email-verifications', {
          params: { header: { 'Idempotency-Key': await verificationIdempotencyKey(secret) } },
          body: { token: secret },
        });
        if (result.data) {
          const session = await apiClient.GET('/me');
          if (session.error) {
            setState('error');
            setMessage(
              'Адрес подтверждён, но сессию создать не удалось. Откройте приложение по защищённому адресу.',
            );
            return;
          }
          setState('success');
          void refresh().catch(() => undefined);
          setMessage('Электронная почта подтверждена. Аккаунт активирован.');
          return;
        }
        const code = result.error?.error?.code;
        setMessage(result.error?.error?.message ?? 'Не удалось подтвердить адрес.');
        setState(
          code === 'TOKEN_INVALID_OR_EXPIRED'
            ? 'invalid'
            : code === 'CONSENT_EVIDENCE_UNAVAILABLE'
              ? 'waiting'
              : 'error',
        );
      } catch {
        setState('error');
        setMessage('Связь прервалась. Безопасно откройте исходную ссылку повторно.');
      }
    }
  }, [parameters, refresh]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center px-5 py-10">
      <section className="w-full rounded-2xl border border-[var(--border)] bg-white p-6 sm:p-10">
        <h1 className="text-3xl font-bold">Подтверждение почты</h1>
        <p className="mt-4" role={state === 'error' || state === 'invalid' ? 'alert' : 'status'}>
          {message}
        </p>
        {state === 'waiting' && (
          <p className="mt-3 text-slate-700">
            Доказательство согласий ещё обрабатывается. Безопасно откройте исходную ссылку повторно
            через несколько секунд.
          </p>
        )}
        {(state === 'invalid' || state === 'error') && (
          <Link
            className="mt-5 inline-block text-[var(--accent)] underline"
            href="/registration/check-email"
          >
            Запросить новое письмо
          </Link>
        )}
        {state === 'success' && (
          <Link className="mt-5 inline-block text-[var(--accent)] underline" href="/">
            Перейти на главную
          </Link>
        )}
      </section>
    </div>
  );
}
