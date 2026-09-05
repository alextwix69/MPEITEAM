import { SessionPanel } from '../../components/session-panel';
import { requireServerSession } from '../../lib/api/server-session';
export default async function AccountPage() {
  await requireServerSession();
  return (
    <div className="mx-auto min-h-screen max-w-xl px-5 py-10">
      <h1 className="text-3xl font-bold">Мой аккаунт</h1>
      <SessionPanel />
    </div>
  );
}
