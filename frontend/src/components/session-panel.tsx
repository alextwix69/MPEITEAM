'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient } from '../lib/api/client';
import { useSession } from './session-provider';

export function SessionPanel() {
  const { session, pending, error, refresh, clear } = useSession();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  async function logout() {
    if (!session) return;
    setSubmitting(true);
    setMessage('');
    try {
      const result = await apiClient.DELETE('/auth/session', {
        params: { header: { 'X-CSRF-Token': session.csrfToken } },
      });
      if (result.error) {
        setMessage(result.error.error.message);
        return;
      }
      await clear();
      router.replace('/');
      router.refresh();
    } catch {
      setMessage('Связь прервалась. Повторите выход.');
    } finally {
      setSubmitting(false);
    }
  }
  if (pending) return <p className="mt-6">Проверяем сессию…</p>;
  if (error)
    return (
      <div className="mt-6">
        <p role="alert">Не удалось проверить сессию.</p>
        <button
          type="button"
          className="underline"
          onClick={() => void refresh().catch(() => undefined)}
        >
          Повторить проверку
        </button>
      </div>
    );
  if (!session)
    return (
      <Link className="mt-6 inline-block text-[var(--accent)] underline" href="/login">
        Войти
      </Link>
    );
  const account = session.account;
  return (
    <section className="mt-6 space-y-3" aria-label="Состояние аккаунта">
      <p>
        {account.state === 'active' && account.capabilities.includes('profile.read')
          ? 'Вы вошли в аккаунт.'
          : account.state === 'unverified'
            ? 'Подтвердите электронную почту. Доступ пока ограничен.'
            : account.state === 'deleting'
              ? 'Аккаунт удаляется. Доступ ограничен.'
              : 'Доступ к аккаунту ограничен.'}
      </p>
      {account.state === 'unverified' && (
        <Link className="block underline" href="/registration/check-email">
          Отправить письмо подтверждения
        </Link>
      )}
      <Link className="mr-5 inline-block underline" href="/account">
        Мой аккаунт
      </Link>
      <button
        className="rounded-lg border border-[var(--border)] px-4 py-2 disabled:opacity-60"
        type="button"
        disabled={submitting}
        onClick={() => void logout()}
      >
        Выйти
      </button>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
