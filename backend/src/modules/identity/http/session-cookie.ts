export function sessionFromCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const matches = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('__Host-session='));
  if (matches.length !== 1) return undefined;
  try {
    const value = decodeURIComponent(matches[0]!.slice('__Host-session='.length));
    return /^[A-Za-z0-9_-]{32,256}$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
