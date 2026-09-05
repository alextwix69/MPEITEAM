import type { ReactNode } from 'react';
import { requireServerSession } from '../../lib/api/server-session';
export const dynamic = 'force-dynamic';
export default async function AccountLayout({ children }: { children: ReactNode }) {
  await requireServerSession();
  return children;
}
