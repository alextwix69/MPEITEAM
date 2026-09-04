import { describe, expect, it } from 'vitest';
import { registrationFormSchema } from '../src/lib/registration-schema';
import { prepareIdempotencyAttempt, verificationIdempotencyKey } from '../src/lib/idempotency';

const base = {
  email: 'student@mpei.ru',
  password: 'very-long-password',
  formalRole: 'student' as const,
  fullName: 'Иван Иванов',
  specialization: 'Энергетика',
  institute: 'ИЭТ',
  course: '2',
  department: '',
  company: '',
  position: '',
  age_18: false,
  user_terms: false,
  personal_data: false,
  public_profile_distribution: false,
};

describe('registration form validation', () => {
  it('keeps all four consent controls unchecked by default', () => {
    const parsed = registrationFormSchema.parse(base);
    expect([
      parsed.age_18,
      parsed.user_terms,
      parsed.personal_data,
      parsed.public_profile_distribution,
    ]).toEqual([false, false, false, false]);
  });

  it('requires role-shaped fields', () => {
    expect(() => registrationFormSchema.parse({ ...base, institute: '', course: '' })).toThrow();
    expect(() =>
      registrationFormSchema.parse({ ...base, formalRole: 'employer', company: '' }),
    ).toThrow();
  });
});

describe('idempotent browser retries', () => {
  it('reuses the key for an unchanged request and rotates it after the payload changes', () => {
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const first = prepareIdempotencyAttempt(undefined, { email: 'student@mpei.ru' }, createKey);
    const retry = prepareIdempotencyAttempt(first, { email: 'student@mpei.ru' }, createKey);
    const changed = prepareIdempotencyAttempt(first, { email: 'teacher@mpei.ru' }, createKey);
    expect(retry.key).toBe(first.key);
    expect(changed.key).not.toBe(first.key);
  });

  it('derives the same verification key after the page is reopened', async () => {
    const token = 'x'.repeat(32);
    await expect(verificationIdempotencyKey(token)).resolves.toBe(
      await verificationIdempotencyKey(token),
    );
  });
});
