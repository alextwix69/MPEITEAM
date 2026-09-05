import { describe, expect, it } from 'vitest';
import {
  loginRequestSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
} from '../../src/modules/identity/identity.schemas';
import { sessionFromCookie } from '../../src/modules/identity/http/session-cookie';
import { parseApiEnvironment } from '../../src/platform/config/env.schema';

describe('auth external input', () => {
  it('distinguishes login and new password limits and rejects unknown fields', () => {
    expect(loginRequestSchema.safeParse({ email: 'user@mpei.ru', password: 'x' }).success).toBe(
      true,
    );
    expect(loginRequestSchema.safeParse({ email: 'user@mpei.ru', password: '' }).success).toBe(
      false,
    );
    expect(
      loginRequestSchema.safeParse({ email: 'user@mpei.ru', password: 'x'.repeat(129) }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: 'user@mpei.ru', password: 'x', role: 'moderator' })
        .success,
    ).toBe(false);
    expect(passwordResetRequestSchema.safeParse({}).success).toBe(false);
    expect(
      passwordResetConfirmSchema.safeParse({ token: 'x'.repeat(32), password: 'x'.repeat(12) })
        .success,
    ).toBe(true);
    expect(
      passwordResetConfirmSchema.safeParse({ token: 'x'.repeat(32), password: 'x'.repeat(11) })
        .success,
    ).toBe(false);
    expect(
      passwordResetConfirmSchema.safeParse({ token: 'x'.repeat(31), password: 'x'.repeat(12) })
        .success,
    ).toBe(false);
    expect(
      passwordResetConfirmSchema.safeParse({ token: 'x'.repeat(2049), password: 'x'.repeat(12) })
        .success,
    ).toBe(false);
  });
  it('rejects malformed, ambiguous and non-opaque session cookies', () => {
    for (const cookie of [
      undefined,
      '__Host-session=%XX',
      '__Host-session=short',
      `__Host-session=${'x'.repeat(43)}; __Host-session=${'y'.repeat(43)}`,
    ])
      expect(sessionFromCookie(cookie)).toBeUndefined();
    expect(sessionFromCookie(`other=1; __Host-session=${'x'.repeat(43)}`)).toBe('x'.repeat(43));
  });
  it('accepts only exact configured origins', () => {
    const env = {
      API_DATABASE_URL: 'postgresql://user:pass@localhost/db?connection_limit=2',
      REDIS_URL: 'redis://localhost',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'media',
      S3_ACCESS_KEY: 'local',
      S3_SECRET_KEY: 'local',
    };
    for (const origin of [
      '*',
      'null',
      'https://app.example/path',
      'https://user:pass@app.example',
      'ftp://app.example',
      '',
    ])
      expect(() => parseApiEnvironment({ ...env, AUTH_ALLOWED_ORIGINS: origin })).toThrow(
        'AUTH_ALLOWED_ORIGINS',
      );
    expect(
      parseApiEnvironment({
        ...env,
        AUTH_ALLOWED_ORIGINS: 'https://app.example,http://localhost:8080',
      }).AUTH_ALLOWED_ORIGINS,
    ).toEqual(['https://app.example', 'http://localhost:8080']);
  });
});
