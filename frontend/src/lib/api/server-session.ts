import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentAccountSchema } from '../auth';

export async function requireServerSession() {
  const cookie = (await cookies()).get('__Host-session');
  if (!cookie || !/^[A-Za-z0-9_-]{32,256}$/u.test(cookie.value))
    redirect('/login?returnTo=/account');
  const baseUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  const url = new URL('/api/v1/me', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Некорректная конфигурация API.');
  const response = await fetch(url, {
    headers: { Cookie: `__Host-session=${cookie.value}` },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) redirect('/login?returnTo=/account');
  if (!response.ok) throw new Error('Не удалось проверить сессию. Повторите попытку позже.');
  const account = currentAccountSchema.parse(await response.json());
  if (account.state === 'deleted') redirect('/login');
  return account;
}
