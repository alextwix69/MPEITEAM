'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api/client';
import { currentAccountSchema, type CurrentAccount } from '../lib/auth';

interface SessionState {
  account: CurrentAccount;
  csrfToken: string;
}
const sessionKey = ['session'] as const;
async function fetchSession({ signal }: { signal: AbortSignal }): Promise<SessionState | null> {
  const me = await apiClient.GET('/me', { cache: 'no-store', signal });
  if (me.response.status === 401) return null;
  if (!me.data) throw new Error('Не удалось проверить сессию. Повторите попытку.');
  const account = currentAccountSchema.parse(me.data);
  const csrf = await apiClient.GET('/auth/csrf', { cache: 'no-store', signal });
  if (csrf.response.status === 401) return null;
  if (!csrf.data || csrf.data.csrfToken.length < 32)
    throw new Error('Не удалось проверить сессию. Повторите попытку.');
  return { account, csrfToken: csrf.data.csrfToken };
}

const SessionContext = createContext<{
  session: SessionState | null | undefined;
  pending: boolean;
  error: boolean;
  refresh: () => Promise<SessionState | null>;
  clear: () => Promise<void>;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const channel = useRef<BroadcastChannel | null>(null);
  const query = useQuery({
    queryKey: sessionKey,
    queryFn: fetchSession,
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
  });
  const identity = query.isError ? undefined : query.data?.account.id;
  useEffect(() => {
    void client.cancelQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
  }, [client, identity]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const current = new BroadcastChannel('komanda-auth');
    channel.current = current;
    current.onmessage = () => {
      void client.cancelQueries().then(() => {
        client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
        client.setQueryData(sessionKey, null);
        void client.invalidateQueries({ queryKey: sessionKey });
      });
    };
    return () => {
      channel.current = null;
      current.close();
    };
  }, [client]);
  async function clear() {
    await client.cancelQueries();
    client.clear();
    client.setQueryData(sessionKey, null);
    channel.current?.postMessage('changed');
  }
  async function refresh() {
    await client.cancelQueries();
    client.clear();
    const session = await client.fetchQuery({
      queryKey: sessionKey,
      queryFn: fetchSession,
      staleTime: 0,
    });
    channel.current?.postMessage('changed');
    return session;
  }
  return (
    <SessionContext.Provider
      value={{
        session: query.isError ? undefined : query.data,
        pending: query.isPending,
        error: query.isError,
        refresh,
        clear,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider required');
  return value;
}
