'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { components } from '../lib/api/generated';
import { apiClient } from '../lib/api/client';
import { ApprovedImage } from './approved-image';

type PublicProfileView = components['schemas']['PublicProfile'];

export function PublicProfile({ accountId }: { accountId: string }) {
  const [profile, setProfile] = useState<PublicProfileView>();
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    let active = true;
    void apiClient
      .GET('/profiles/{accountId}', {
        params: { path: { accountId } },
        cache: 'no-store',
      })
      .then((result) => {
        if (!active) return;
        if (result.data) setProfile(result.data);
        else setNotFound(true);
      });
    return () => {
      active = false;
    };
  }, [accountId]);
  if (notFound) return <p>Публичный профиль не найден.</p>;
  if (!profile) return <p>Загружаем профиль…</p>;
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 px-5 py-10">
      <Link href="/account">Назад в аккаунт</Link>
      <header>
        {profile.profile.avatarMediaId && (
          <ApprovedImage mediaId={profile.profile.avatarMediaId} alt="Аватар профиля" />
        )}
        <h1 className="text-3xl font-bold">{profile.profile.fullName}</h1>
        <p className="mt-2 text-lg">{profile.profile.specialization}</p>
        <p className="text-slate-600">{profile.formalRole}</p>
      </header>
      {profile.resumes.map((resume) => (
        <article key={resume.id} className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Основное резюме</h2>
          {resume.imageMediaId && (
            <ApprovedImage mediaId={resume.imageMediaId} alt="Изображение резюме" />
          )}
          <p className="whitespace-pre-wrap">{resume.about}</p>
          {resume.projects.map((project) => (
            <section key={`${project.title}-${project.url ?? ''}`}>
              <h3 className="font-semibold">{project.title}</h3>
              <p>{project.description}</p>
              {project.url && (
                <a href={project.url} rel="noreferrer">
                  Открыть проект
                </a>
              )}
            </section>
          ))}
        </article>
      ))}
    </main>
  );
}
