'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import type { components } from '../lib/api/generated';
import { apiClient } from '../lib/api/client';
import { useSession } from './session-provider';
import { MediaUpload } from './media-upload';
import { ModerationStatus } from './moderation-status';
import { Button } from './ui/button';

type Profile = components['schemas']['Profile'];
type ProfileInput = components['schemas']['ProfileInput'];
type Resume = components['schemas']['Resume'];

const emptyInput: ProfileInput = {
  fullName: '',
  specialization: '',
  timezone: 'Europe/Moscow',
};

export function ProfileEditor() {
  const { session } = useSession();
  const [profile, setProfile] = useState<Profile>();
  const [resume, setResume] = useState<Resume>();
  const [input, setInput] = useState<ProfileInput>(emptyInput);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      apiClient.GET('/me/profile', { cache: 'no-store' }),
      apiClient.GET('/me/resumes', { cache: 'no-store' }),
    ]).then(([profileResult, resumesResult]) => {
      if (!active) return;
      if (!profileResult.data || !resumesResult.data) {
        setMessage('Не удалось загрузить профиль. Обновите страницу.');
        return;
      }
      setProfile(profileResult.data);
      setInput(profileResult.data.pending ?? profileResult.data.published ?? emptyInput);
      setResume(resumesResult.data.items.find((item) => item.primary));
    });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !profile) return;
    setBusy(true);
    setMessage('');
    const role = session.account.formalRole;
    const body: ProfileInput = {
      fullName: input.fullName.trim(),
      specialization: input.specialization.trim(),
      timezone: input.timezone,
      ...(role === 'student' ? { institute: input.institute?.trim(), course: input.course } : {}),
      ...(role === 'teacher'
        ? { department: input.department?.trim(), position: input.position?.trim() || undefined }
        : {}),
      ...(role === 'employer'
        ? { company: input.company?.trim(), position: input.position?.trim() || undefined }
        : {}),
      ...(input.avatarMediaId ? { avatarMediaId: input.avatarMediaId } : {}),
    };
    const result = await apiClient.PATCH('/me/profile', {
      params: {
        header: {
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
          'If-Match': `"${profile.rowVersion}"`,
        },
      },
      body,
    });
    setBusy(false);
    if (!result.data) {
      setMessage(
        result.error?.error.code === 'VERSION_MISMATCH'
          ? 'Профиль уже изменился. Обновите страницу и повторите ввод.'
          : (result.error?.error.message ?? 'Не удалось сохранить профиль.'),
      );
      return;
    }
    setProfile(result.data);
    setInput(result.data.pending ?? result.data.published ?? emptyInput);
    setMessage('Новая версия сохранена и отправлена на проверку.');
  }

  if (!session || !profile) return <p>{message || 'Загружаем профиль…'}</p>;
  const role = session.account.formalRole;
  return (
    <div className="mx-auto min-h-screen max-w-3xl space-y-6 px-5 py-10">
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/account">Аккаунт</Link>
        {resume && <Link href={`/account/resumes/${resume.id}`}>Основное резюме</Link>}
        <Link href="/notifications">Уведомления</Link>
      </nav>
      <div>
        <h1 className="text-3xl font-bold">Мой профиль</h1>
        <p className="mt-2 text-slate-600">
          Новые данные станут публичными только после автоматической проверки.
        </p>
      </div>
      <ModerationStatus moderation={profile.moderation} />
      {profile.published && (
        <section className="rounded-xl bg-slate-100 p-4">
          <h2 className="font-semibold">Сейчас опубликовано</h2>
          <p>{profile.published.fullName}</p>
          <p className="text-sm text-slate-600">{profile.published.specialization}</p>
        </section>
      )}
      <form className="space-y-4 rounded-2xl bg-white p-5 shadow-sm" onSubmit={submit}>
        <label className="block">
          <span className="mb-1 block font-medium">ФИО</span>
          <input
            className="w-full rounded-lg border p-3"
            required
            maxLength={200}
            value={input.fullName}
            onChange={(event) => update('fullName', event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium">Специализация</span>
          <input
            className="w-full rounded-lg border p-3"
            required
            maxLength={200}
            value={input.specialization}
            onChange={(event) => update('specialization', event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium">Часовой пояс</span>
          <input
            className="w-full rounded-lg border p-3"
            required
            maxLength={64}
            value={input.timezone}
            onChange={(event) => update('timezone', event.target.value)}
          />
        </label>
        {role === 'student' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="mb-1 block font-medium">Институт</span>
              <input
                className="w-full rounded-lg border p-3"
                required
                maxLength={200}
                value={input.institute ?? ''}
                onChange={(event) => update('institute', event.target.value)}
              />
            </label>
            <label>
              <span className="mb-1 block font-medium">Курс</span>
              <input
                className="w-full rounded-lg border p-3"
                type="number"
                min={1}
                max={6}
                required
                value={input.course ?? 1}
                onChange={(event) => update('course', Number(event.target.value))}
              />
            </label>
          </div>
        )}
        {role === 'teacher' && (
          <label>
            <span className="mb-1 block font-medium">Кафедра</span>
            <input
              className="w-full rounded-lg border p-3"
              required
              maxLength={200}
              value={input.department ?? ''}
              onChange={(event) => update('department', event.target.value)}
            />
          </label>
        )}
        {role === 'employer' && (
          <label>
            <span className="mb-1 block font-medium">Компания</span>
            <input
              className="w-full rounded-lg border p-3"
              required
              maxLength={200}
              value={input.company ?? ''}
              onChange={(event) => update('company', event.target.value)}
            />
          </label>
        )}
        {role !== 'student' && (
          <label>
            <span className="mb-1 block font-medium">Должность</span>
            <input
              className="w-full rounded-lg border p-3"
              maxLength={200}
              value={input.position ?? ''}
              onChange={(event) => update('position', event.target.value)}
            />
          </label>
        )}
        <MediaUpload
          contentScope="public_content"
          ownerType="profile"
          ownerId={profile.id}
          onReady={(avatarMediaId) => update('avatarMediaId', avatarMediaId)}
        />
        <Button disabled={busy || profile.editLocked} type="submit">
          {busy ? 'Сохраняем…' : 'Сохранить и отправить на проверку'}
        </Button>
        {message && <p role="status">{message}</p>}
      </form>
    </div>
  );
}
