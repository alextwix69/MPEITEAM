import Link from 'next/link';
import { SessionPanel } from '../../components/session-panel';
import { requireServerSession } from '../../lib/api/server-session';
export default async function AccountPage() {
  await requireServerSession();
  return (
    <div className="mx-auto min-h-screen max-w-xl px-5 py-10">
      <h1 className="text-3xl font-bold">Мой аккаунт</h1>
      <nav className="my-6 flex flex-wrap gap-4">
        <Link href="/account/profile">Редактировать профиль</Link>
        <Link href="/notifications">Уведомления</Link>
      </nav>
      <SessionPanel />
    </div>
  );
}
