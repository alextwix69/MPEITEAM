import { notFound } from 'next/navigation';

const names: Record<string, string> = {
  age_18: 'Подтверждение достижения 18 лет',
  user_terms: 'Пользовательское соглашение',
  personal_data: 'Согласие на обработку персональных данных',
  public_profile_distribution: 'Согласие на распространение данных публичного профиля',
};

export default async function LegalDocumentPage({
  params,
}: Readonly<{ params: Promise<{ document: string }> }>) {
  const { document } = await params;
  const name = names[document];
  if (!name) notFound();
  return (
    <article className="mx-auto max-w-3xl px-5 py-10 sm:px-10">
      <h1 className="text-3xl font-bold">{name}</h1>
      <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
        Это локальная версия интерфейса для разработки. Публичный запуск запрещён до публикации
        утверждённого юридического текста и номера его версии.
      </p>
      {document === 'public_profile_distribution' && (
        <section className="mt-6 space-y-4">
          <p>
            Согласие разрешает показывать другим вошедшим пользователям обязательные данные
            публичного профиля:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>ФИО, формальную роль и специализацию;</li>
            <li>институт и курс студента;</li>
            <li>кафедру преподавателя;</li>
            <li>компанию работодателя и должность, если она указана;</li>
            <li>основное резюме.</li>
          </ul>
          <p>
            Электронная почта, пароль и переписка не входят в публичный профиль. Аватар, теги,
            разделы «Обо мне» и «Мои проекты», а также дополнительные резюме становятся доступны
            другим пользователям только после добровольного заполнения или публикации владельцем.
          </p>
        </section>
      )}
    </article>
  );
}
