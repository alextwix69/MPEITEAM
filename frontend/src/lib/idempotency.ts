export interface PendingIdempotencyAttempt {
  fingerprint: string;
  key: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function prepareIdempotencyAttempt(
  current: PendingIdempotencyAttempt | undefined,
  body: unknown,
  createKey: () => string = () => crypto.randomUUID(),
): PendingIdempotencyAttempt {
  const fingerprint = canonicalJson(body);
  return current?.fingerprint === fingerprint ? current : { fingerprint, key: createKey() };
}

export async function verificationIdempotencyKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
