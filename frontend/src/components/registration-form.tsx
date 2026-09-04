'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { components } from '../lib/api/generated';
import { apiClient } from '../lib/api/client';
import { prepareIdempotencyAttempt, type PendingIdempotencyAttempt } from '../lib/idempotency';
import { registrationFormSchema, type RegistrationFormValues } from '../lib/registration-schema';
type DocumentType = components['schemas']['ConsentAcceptance']['documentType'];

interface RegistrationFormProperties {
  documentVersions: Record<DocumentType, string>;
}

const consentLabels: Record<DocumentType, string> = {
  age_18: 'Подтверждаю, что мне исполнилось 18 лет',
  user_terms: 'Принимаю пользовательское соглашение',
  personal_data: 'Даю согласие на обработку персональных данных',
  public_profile_distribution:
    'Даю отдельное согласие на распространение данных публичного профиля',
};

export function RegistrationForm({ documentVersions }: RegistrationFormProperties) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string>();
  const [pendingAttempt, setPendingAttempt] = useState<PendingIdempotencyAttempt>();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<RegistrationFormValues>({
    resolver: zodResolver(registrationFormSchema),
    defaultValues: {
      formalRole: 'student',
      institute: '',
      course: '',
      department: '',
      company: '',
      position: '',
      age_18: false,
      user_terms: false,
      personal_data: false,
      public_profile_distribution: false,
    },
  });
  const role = useWatch({ control, name: 'formalRole' });

  async function submit(values: RegistrationFormValues): Promise<void> {
    setServerError(undefined);
    const consentTypes = Object.keys(consentLabels) as DocumentType[];
    if (consentTypes.some((type) => !values[type])) {
      setServerError('Подтвердите каждое обязательное согласие отдельно.');
      return;
    }
    const profile: components['schemas']['ProfileInput'] = {
      fullName: values.fullName,
      specialization: values.specialization,
      timezone: 'Europe/Moscow',
      ...(role === 'student' ? { institute: values.institute, course: Number(values.course) } : {}),
      ...(role === 'teacher' ? { department: values.department } : {}),
      ...(role === 'employer'
        ? { company: values.company, ...(values.position ? { position: values.position } : {}) }
        : {}),
    };
    const body = {
      email: values.email,
      password: values.password,
      formalRole: role,
      profile,
      consents: consentTypes.map((documentType) => ({
        documentType,
        documentVersion: documentVersions[documentType],
        accepted: true as const,
      })),
    };
    const attempt = prepareIdempotencyAttempt(pendingAttempt, body);
    setPendingAttempt(attempt);
    try {
      const result = await apiClient.POST('/auth/registrations', {
        params: { header: { 'Idempotency-Key': attempt.key } },
        body,
      });
      if (result.error) {
        if (!result.error.error?.retryable) setPendingAttempt(undefined);
        setServerError(
          result.error.error?.message ?? 'Не удалось завершить регистрацию. Повторите попытку.',
        );
        return;
      }
      setPendingAttempt(undefined);
      router.push('/registration/check-email');
    } catch {
      setServerError(
        'Связь прервалась. Повторите попытку — тот же запрос будет безопасно продолжен.',
      );
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-10">
      <Link className="text-sm text-[var(--accent)] underline" href="/">
        На главную
      </Link>
      <h1 className="mt-5 text-3xl font-bold">Регистрация</h1>
      <p className="mt-3 text-slate-700">
        Студенты и преподаватели используют адрес @mpei.ru. Выбранная роль не проверяется и не
        предоставляет системных прав.
      </p>
      {serverError && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
          {serverError}
        </div>
      )}
      <form className="mt-8 space-y-6" onSubmit={handleSubmit(submit)} noValidate>
        <Field label="Электронная почта" error={errors.email?.message}>
          <input autoComplete="email" type="email" {...register('email')} />
        </Field>
        <Field label="Пароль" error={errors.password?.message}>
          <input autoComplete="new-password" type="password" {...register('password')} />
        </Field>
        <Field label="Формальная роль" error={errors.formalRole?.message}>
          <select {...register('formalRole')}>
            <option value="student">Студент</option>
            <option value="teacher">Преподаватель</option>
            <option value="employer">Работодатель</option>
          </select>
        </Field>
        <Field label="ФИО" error={errors.fullName?.message}>
          <input autoComplete="name" {...register('fullName')} />
        </Field>
        <Field label="Специализация" error={errors.specialization?.message}>
          <input {...register('specialization')} />
        </Field>
        {role === 'student' && (
          <>
            <Field label="Институт" error={errors.institute?.message}>
              <input {...register('institute', { required: true })} />
            </Field>
            <Field label="Курс" error={errors.course?.message}>
              <select {...register('course', { required: true })}>
                <option value="">Выберите курс</option>
                {[1, 2, 3, 4, 5, 6].map((course) => (
                  <option key={course} value={course}>
                    {course}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {role === 'teacher' && (
          <Field label="Кафедра" error={errors.department?.message}>
            <input {...register('department', { required: true })} />
          </Field>
        )}
        {role === 'employer' && (
          <>
            <Field label="Компания" error={errors.company?.message}>
              <input {...register('company', { required: true })} />
            </Field>
            <Field label="Должность (необязательно)" error={errors.position?.message}>
              <input {...register('position')} />
            </Field>
          </>
        )}
        <fieldset className="space-y-4 rounded-2xl border border-[var(--border)] p-5">
          <legend className="px-2 font-semibold">Обязательные подтверждения</legend>
          {(Object.keys(consentLabels) as DocumentType[]).map((type) => (
            <label className="flex items-start gap-3" key={type}>
              <input className="mt-1 h-5 w-5" type="checkbox" {...register(type)} />
              <span>
                {consentLabels[type]}{' '}
                <Link className="text-[var(--accent)] underline" href={`/legal/${type}`}>
                  (версия {documentVersions[type]})
                </Link>
              </span>
            </label>
          ))}
        </fieldset>
        <button
          className="rounded-lg bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-60"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? 'Создаём аккаунт…' : 'Создать аккаунт'}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: Readonly<{ label: string; error?: string; children: React.ReactNode }>) {
  return (
    <label className="block space-y-2">
      <span className="font-medium">{label}</span>
      <span className="block [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-[var(--border)] [&_input]:bg-white [&_input]:p-3 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-[var(--border)] [&_select]:bg-white [&_select]:p-3">
        {children}
      </span>
      {error && <span className="block text-sm text-[var(--danger)]">{error}</span>}
    </label>
  );
}
