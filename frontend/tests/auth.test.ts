import { describe, expect, it } from 'vitest';
import { authFormSchema, currentAccountSchema, safeReturnPath } from '../src/lib/auth';

describe('auth forms and navigation', () => {
  it('uses the contract password constraints for each form', () => {
    expect(
      authFormSchema('login').safeParse({ email: 'user@mpei.ru', password: 'x' }).success,
    ).toBe(true);
    expect(authFormSchema('reset').safeParse({ email: '', password: 'short' }).success).toBe(false);
    expect(
      authFormSchema('reset').safeParse({ email: '', password: 'new-long-password' }).success,
    ).toBe(true);
    expect(authFormSchema('forgot').safeParse({ email: 'not-email', password: '' }).success).toBe(
      false,
    );
  });
  it.each([
    null,
    '//attacker.example',
    '/%2fattacker.example',
    '/\\attacker.example',
    '/%5cattacker.example',
    'https://attacker.example',
    '/%0aevil',
    '/%zz',
  ])('rejects unsafe return destination %s', (value) => expect(safeReturnPath(value)).toBe('/'));
  it('preserves a local deep link', () =>
    expect(safeReturnPath('/account?view=me')).toBe('/account?view=me'));
  it('accepts unknown response fields and states without inventing capabilities', () => {
    const value = currentAccountSchema.parse({
      id: '0198a8e7-5132-7c8b-a566-0242ac120002',
      formalRole: 'student',
      systemRole: 'user',
      state: 'future',
      emailVerified: true,
      capabilities: [],
      createdAt: '2026-09-05T10:00:00Z',
      extra: 1,
    });
    expect(value.state).toBe('future');
    expect(value.capabilities).toEqual([]);
    expect(value).not.toHaveProperty('extra');
  });
});
