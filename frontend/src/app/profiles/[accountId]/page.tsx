import { PublicProfile } from '../../../components/public-profile';
import { requireServerSession } from '../../../lib/api/server-session';

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  await requireServerSession();
  const { accountId } = await params;
  return <PublicProfile accountId={accountId} />;
}
