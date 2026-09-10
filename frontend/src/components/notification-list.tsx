'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { components } from '../lib/api/generated';
import { apiClient } from '../lib/api/client';
import { useSession } from './session-provider';
import { Button } from './ui/button';

type Notification = components['schemas']['Notification'];

export function NotificationList() {
  const { session } = useSession();
  const [items, setItems] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [message, setMessage] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = useCallback(
    async (next?: string, append = false) => {
      const result = await apiClient.GET('/notifications', {
        params: { query: { limit: 20, ...(next ? { cursor: next } : {}), unreadOnly } },
        cache: 'no-store',
      });
      if (!result.data) {
        setMessage('Не удалось загрузить уведомления.');
        return;
      }
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setCursor(result.data.page.nextCursor);
    },
    [unreadOnly],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function markRead(notification: Notification) {
    if (!session || notification.read) return;
    const result = await apiClient.PATCH('/notifications/{notificationId}', {
      params: {
        path: { notificationId: notification.id },
        header: {
          'X-CSRF-Token': session.csrfToken,
          'If-Match': `"${notification.rowVersion}"`,
          'Idempotency-Key': crypto.randomUUID(),
        },
      },
      body: { read: true },
    });
    if (!result.data) {
      setMessage('Не удалось отметить уведомление прочитанным. Обновите список.');
      return;
    }
    setItems((current) =>
      current.map((item) => (item.id === result.data?.id ? result.data : item)),
    );
  }

  async function markAllRead() {
    if (!session) return;
    const result = await apiClient.POST('/notifications/read-all', {
      params: {
        header: {
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
        },
      },
      body: { before: new Date().toISOString() },
    });
    if (!result.data) {
      setMessage('Не удалось обновить уведомления.');
      return;
    }
    setItems((current) => current.map((item) => ({ ...item, read: true })));
    setMessage(`Прочитано уведомлений: ${result.data.updatedCount}.`);
  }

  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 px-5 py-10">
      <nav>
        <Link href="/account/profile">Профиль</Link>
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Уведомления</h1>
        <Button type="button" variant="secondary" onClick={() => void markAllRead()}>
          Прочитать все
        </Button>
      </div>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(event) => setUnreadOnly(event.target.checked)}
        />
        <span>Только непрочитанные</span>
      </label>
      {message && <p role="status">{message}</p>}
      <ol className="space-y-3">
        {items.map((notification) => {
          const approved = notification.type === 'moderation_approved';
          return (
            <li
              key={notification.id}
              className={`rounded-xl border bg-white p-4 ${notification.read ? 'opacity-70' : ''}`}
            >
              <p className="font-semibold">
                {approved ? 'Материал одобрен' : 'Материал нужно доработать'}
              </p>
              {typeof notification.payload.reason === 'string' && (
                <p className="mt-1 text-sm">{notification.payload.reason}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                {notification.resourceType === 'profile' && (
                  <Link href="/account/profile">Открыть профиль</Link>
                )}
                {notification.resourceType === 'resume' && notification.resourceId && (
                  <Link href={`/account/resumes/${notification.resourceId}`}>Открыть резюме</Link>
                )}
                {!notification.read && (
                  <button
                    className="underline"
                    type="button"
                    onClick={() => void markRead(notification)}
                  >
                    Отметить прочитанным
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!items.length && <p>Уведомлений пока нет.</p>}
      {cursor && (
        <Button type="button" variant="secondary" onClick={() => void load(cursor, true)}>
          Показать ещё
        </Button>
      )}
    </main>
  );
}
