import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hmacSha256(key: string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function encryptSecret(keyHex: string, value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(keyHex: string, envelope: Uint8Array): string {
  const bytes = Buffer.from(envelope);
  if (bytes.length < 29) throw new Error('INVALID_SECRET_ENVELOPE');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
