import { HealthPanel } from '../components/health-panel';
import Link from 'next/link';

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-5 py-12 sm:px-10">
      <section className="w-full rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl shadow-slate-300/30 sm:p-12">
        <p className="mb-3 text-sm font-semibold tracking-[0.16em] text-[var(--accent)] uppercase">
          Проектные команды МЭИ
        </p>
        <h1 className="max-w-3xl text-4xl leading-tight font-bold tracking-tight sm:text-6xl">
          Команда.МЭИ
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
          Сервис запускается. Возможности для участников и проектных команд появятся в следующих
          версиях.
        </p>
        <HealthPanel />
        <Link
          className="mt-6 inline-flex rounded-lg bg-[var(--accent)] px-5 py-3 font-semibold text-white"
          href="/registration"
        >
          Зарегистрироваться
        </Link>
      </section>
    </div>
  );
}
