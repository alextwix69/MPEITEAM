'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { components } from '../lib/api/generated';
import { apiClient } from '../lib/api/client';
import { MediaUpload } from './media-upload';
import { ModerationStatus } from './moderation-status';
import { useSession } from './session-provider';
import { Button } from './ui/button';

type Resume = components['schemas']['Resume'];
type ResumeInput = components['schemas']['ResumeInput'];
type Project = components['schemas']['Project'];
type Tag = components['schemas']['Tag'];

const emptyInput: ResumeInput = { about: '', projects: [], tagIds: [], searchVisible: true };

export function ResumeEditor({ resumeId }: { resumeId: string }) {
  const { session } = useSession();
  const [resume, setResume] = useState<Resume>();
  const [input, setInput] = useState<ResumeInput>(emptyInput);
  const [tags, setTags] = useState<Tag[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      apiClient.GET('/me/resumes/{resumeId}', {
        params: { path: { resumeId } },
        cache: 'no-store',
      }),
      apiClient.GET('/catalog/tags', { cache: 'force-cache' }),
    ]).then(([resumeResult, catalogResult]) => {
      if (!active) return;
      if (!resumeResult.data || !catalogResult.data) {
        setMessage('Не удалось загрузить резюме. Обновите страницу.');
        return;
      }
      setResume(resumeResult.data);
      setInput(resumeResult.data.pending ?? resumeResult.data.published ?? emptyInput);
      setTags(catalogResult.data.items);
    });
    return () => {
      active = false;
    };
  }, [resumeId]);

  const categories = useMemo(
    () =>
      [...new Set(tags.map((tag) => tag.category))].map((category) => ({
        category,
        items: tags.filter((tag) => tag.category === category),
      })),
    [tags],
  );

  function updateProject(index: number, field: keyof Project, value: string) {
    setInput((current) => ({
      ...current,
      projects: current.projects.map((project, position) =>
        position === index ? { ...project, [field]: value || undefined } : project,
      ),
    }));
  }

  function toggleTag(tagId: string) {
    setInput((current) => {
      const selected = current.tagIds.includes(tagId);
      if (!selected && current.tagIds.length >= 20) return current;
      return {
        ...current,
        tagIds: selected
          ? current.tagIds.filter((candidate) => candidate !== tagId)
          : [...current.tagIds, tagId],
      };
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !resume) return;
    setBusy(true);
    setMessage('');
    const result = await apiClient.PATCH('/me/resumes/{resumeId}', {
      params: {
        path: { resumeId },
        header: {
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
          'If-Match': `"${resume.rowVersion}"`,
        },
      },
      body: { ...input, searchVisible: true },
    });
    setBusy(false);
    if (!result.data) {
      setMessage(
        result.error?.error.code === 'VERSION_MISMATCH'
          ? 'Резюме уже изменилось. Обновите страницу и повторите ввод.'
          : (result.error?.error.message ?? 'Не удалось сохранить резюме.'),
      );
      return;
    }
    setResume(result.data);
    setInput(result.data.pending ?? result.data.published ?? emptyInput);
    setMessage('Резюме сохранено и отправлено на проверку.');
  }

  if (!resume) return <p>{message || 'Загружаем резюме…'}</p>;
  const checking = resume.moderation?.state === 'pending';
  return (
    <div className="mx-auto min-h-screen max-w-4xl space-y-6 px-5 py-10">
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/account/profile">Профиль</Link>
        <Link href="/notifications">Уведомления</Link>
      </nav>
      <div>
        <h1 className="text-3xl font-bold">Основное резюме</h1>
        <p className="mt-2 text-slate-600">Оно всегда участвует в будущем поиске людей.</p>
      </div>
      <ModerationStatus moderation={resume.moderation} />
      {resume.published && (
        <section className="rounded-xl bg-slate-100 p-4">
          <h2 className="font-semibold">Сейчас опубликовано</h2>
          <p className="whitespace-pre-wrap">{resume.published.about}</p>
        </section>
      )}
      <form className="space-y-6 rounded-2xl bg-white p-5 shadow-sm" onSubmit={submit}>
        <label className="block">
          <span className="mb-1 block font-medium">Обо мне</span>
          <textarea
            className="min-h-36 w-full rounded-lg border p-3"
            maxLength={1024}
            value={input.about}
            onChange={(event) => setInput((current) => ({ ...current, about: event.target.value }))}
          />
          <span className="text-sm text-slate-600">{input.about.length}/1024</span>
        </label>
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Проекты</h2>
            <Button
              type="button"
              variant="secondary"
              disabled={input.projects.length >= 10}
              onClick={() =>
                setInput((current) => ({
                  ...current,
                  projects: [...current.projects, { title: '', description: '' }],
                }))
              }
            >
              Добавить проект
            </Button>
          </div>
          {input.projects.map((project, index) => (
            <fieldset key={index} className="space-y-2 rounded-xl border p-4">
              <legend className="px-1 font-medium">Проект {index + 1}</legend>
              <input
                aria-label={`Название проекта ${index + 1}`}
                className="w-full rounded-lg border p-3"
                required
                maxLength={200}
                value={project.title}
                onChange={(event) => updateProject(index, 'title', event.target.value)}
              />
              <textarea
                aria-label={`Описание проекта ${index + 1}`}
                className="w-full rounded-lg border p-3"
                required
                maxLength={2000}
                value={project.description}
                onChange={(event) => updateProject(index, 'description', event.target.value)}
              />
              <input
                aria-label={`Ссылка проекта ${index + 1}`}
                className="w-full rounded-lg border p-3"
                type="url"
                maxLength={2048}
                value={project.url ?? ''}
                onChange={(event) => updateProject(index, 'url', event.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setInput((current) => ({
                    ...current,
                    projects: current.projects.filter((_, position) => position !== index),
                  }))
                }
              >
                Удалить проект
              </Button>
            </fieldset>
          ))}
        </section>
        <section>
          <h2 className="text-xl font-semibold">Навыки и интересы</h2>
          <p className="text-sm text-slate-600">Выбрано {input.tagIds.length} из 20</p>
          <div className="mt-3 max-h-96 space-y-5 overflow-y-auto rounded-xl border p-4">
            {categories.map(({ category, items }) => (
              <fieldset key={category}>
                <legend className="font-semibold">{category}</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {items.map((tag) => (
                    <label key={tag.id} className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={input.tagIds.includes(tag.id)}
                        disabled={!input.tagIds.includes(tag.id) && input.tagIds.length >= 20}
                        onChange={() => toggleTag(tag.id)}
                      />
                      <span>{tag.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </section>
        <MediaUpload
          contentScope="public_content"
          ownerType="resume"
          ownerId={resume.id}
          onReady={(imageMediaId) => setInput((current) => ({ ...current, imageMediaId }))}
        />
        <Button disabled={busy || checking || resume.editLocked} type="submit">
          {busy ? 'Сохраняем…' : 'Сохранить и отправить на проверку'}
        </Button>
        {message && <p role="status">{message}</p>}
      </form>
    </div>
  );
}
