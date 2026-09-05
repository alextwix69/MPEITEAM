'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { apiClient } from '../lib/api/client';
import { authFormSchema, safeReturnPath } from '../lib/auth';
import { prepareIdempotencyAttempt, type PendingIdempotencyAttempt } from '../lib/idempotency';
import { useSession } from './session-provider';

export function AuthForm({ mode }: { mode: 'login' | 'forgot' | 'reset' }) {
  const router = useRouter();
  const parameters = useSearchParams();
  const { refresh, clear } = useSession();
  const token = useRef<string | null>(null);
  const captured = useRef(false);
  const attempt = useRef<PendingIdempotencyAttempt>(undefined);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string; password: string }>({
    resolver: zodResolver(authFormSchema(mode)),
    defaultValues: { email: '', password: '' },
  });
  useEffect(() => {
    if (mode !== 'reset' || captured.current) return;
    captured.current = true;
    token.current = parameters.get('token');
    window.history.replaceState({}, '', '/reset-password');
  }, [mode, parameters]);

  async function submit(values: { email: string; password: string }) {
    setMessage('');
    setSuccess(false);
    if (Date.now() < retryAt) {
      setMessage('Повторите запрос чуть позже.');
      return;
    }
    if (
      mode === 'reset' &&
      (!token.current || token.current.length < 32 || token.current.length > 2048)
    ) {
      setMessage('Ссылка недействительна. Запросите новое письмо.');
      return;
    }
    const body =
      mode === 'login'
        ? values
        : mode === 'forgot'
          ? { email: values.email }
          : { token: token.current!, password: values.password };
    attempt.current = prepareIdempotencyAttempt(attempt.current, body);
    const header = { 'Idempotency-Key': attempt.current.key };
    try {
      const result =
        mode === 'login'
          ? await apiClient.POST('/auth/sessions', { params: { header }, body: values })
          : mode === 'forgot'
            ? await apiClient.POST('/auth/password-resets', {
                params: { header },
                body: { email: values.email },
              })
            : await apiClient.POST('/auth/password-resets/confirm', {
                params: { header },
                body: { token: token.current!, password: values.password },
              });
      if (result.error) {
        setMessage(result.error.error.message);
        if (!result.error.error.retryable) attempt.current = undefined;
        const seconds = Number(result.response.headers.get('Retry-After'));
        if (Number.isFinite(seconds) && seconds > 0) setRetryAt(Date.now() + seconds * 1000);
        return;
      }
      attempt.current = undefined;
      reset();
      if (mode === 'forgot') {
        setSuccess(true);
        setMessage('Если восстановление доступно, письмо отправлено на указанную почту.');
        return;
      }
      if (mode === 'reset') {
        token.current = null;
        await clear();
        router.replace('/login?reset=success');
        router.refresh();
        return;
      }
      const session = await refresh();
      if (!session) {
        setMessage('Сессия завершена. Войдите ещё раз.');
        return;
      }
      router.replace(safeReturnPath(parameters.get('returnTo')));
      router.refresh();
    } catch {
      setMessage('Связь прервалась. Повторите тот же запрос.');
    }
  }
  const title =
    mode === 'login' ? 'Вход' : mode === 'forgot' ? 'Восстановление доступа' : 'Новый пароль';
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center px-5 py-10">
      <section className="w-full rounded-2xl border border-[var(--border)] bg-white p-6 sm:p-10">
        <h1 className="text-3xl font-bold">{title}</h1>
        {mode === 'login' && parameters.get('reset') === 'success' && (
          <p className="mt-4" role="status">
            Пароль изменён. Войдите с новым паролем.
          </p>
        )}
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => void handleSubmit(submit)(event)}
          noValidate
        >
          {mode !== 'reset' && (
            <div>
              <label className="block font-medium" htmlFor="auth-email">
                Электронная почта
              </label>
              <input
                id="auth-email"
                type="email"
                autoComplete="username"
                maxLength={320}
                className="mt-2 w-full rounded-lg border border-[var(--border)] p-3"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'email-error' : undefined}
                {...register('email')}
              />
              {errors.email && (
                <p id="email-error" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>
          )}
          {mode !== 'forgot' && (
            <div>
              <label className="block font-medium" htmlFor="auth-password">
                {mode === 'reset' ? 'Новый пароль' : 'Пароль'}
              </label>
              <input
                id="auth-password"
                type="password"
                autoComplete={mode === 'reset' ? 'new-password' : 'current-password'}
                maxLength={128}
                className="mt-2 w-full rounded-lg border border-[var(--border)] p-3"
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              {errors.password && (
                <p id="password-error" role="alert">
                  {errors.password.message}
                </p>
              )}
            </div>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-60"
          >
            {isSubmitting
              ? 'Подождите…'
              : mode === 'login'
                ? 'Войти'
                : mode === 'forgot'
                  ? 'Отправить письмо'
                  : 'Сохранить пароль'}
          </button>
          {message && <p role={success ? 'status' : 'alert'}>{message}</p>}
        </form>
        <nav className="mt-6 flex flex-wrap gap-4" aria-label="Доступ к аккаунту">
          <Link className="underline" href="/registration">
            Регистрация
          </Link>
          <Link
            className="underline"
            href={mode === 'login' || mode === 'reset' ? '/forgot-password' : '/login'}
          >
            {mode === 'login' || mode === 'reset' ? 'Восстановить доступ' : 'Войти'}
          </Link>
        </nav>
      </section>
    </div>
  );
}
