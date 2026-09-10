import { NotificationList } from '../../components/notification-list';
import { requireServerSession } from '../../lib/api/server-session';

export default async function NotificationsPage() {
  await requireServerSession();
  return <NotificationList />;
}
