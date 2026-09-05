import { z } from 'zod';

export const currentAccountSchema = z.object({
  id: z.uuid(),
  formalRole: z.string(),
  systemRole: z.string(),
  state: z.string(),
  emailVerified: z.boolean(),
  capabilities: z.array(z.string()),
  createdAt: z.iso.datetime({ offset: true }),
  deletionIrreversibleAt: z.iso.datetime({ offset: true }).optional(),
});
export type CurrentAccount = z.infer<typeof currentAccountSchema>;

function unsafePath(value: string): boolean {
  return (
    value.includes('\\') || Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  );
}

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || unsafePath(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || unsafePath(decoded)) return '/';
    const url = new URL(value, 'https://local.invalid');
    return url.origin === 'https://local.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

export function authFormSchema(mode: 'login' | 'forgot' | 'reset') {
  return z.object({
    email: mode === 'reset' ? z.string() : z.email('Введите корректную почту.').max(320),
    password:
      mode === 'forgot'
        ? z.string()
        : z
            .string()
            .min(
              mode === 'reset' ? 12 : 1,
              mode === 'reset' ? 'Не менее 12 символов.' : 'Введите пароль.',
            )
            .max(128, 'Не более 128 символов.'),
  });
}
