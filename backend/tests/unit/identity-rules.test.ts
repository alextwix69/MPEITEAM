import { describe, expect, it } from 'vitest';
import { parseApiEnvironment } from '../../src/platform/config/env.schema';
import { canonicalJson, decryptSecret, encryptSecret } from '../../src/platform/security/crypto';
import {
  IdentityService,
  normalizeEmail,
} from '../../src/modules/identity/application/identity.service';
import { registrationRequestSchema } from '../../src/modules/identity/identity.schemas';

const environment = parseApiEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?connection_limit=2',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'local-secret',
});

const service = new IdentityService({} as never, {} as never, {} as never, environment);

function registration(overrides: Record<string, unknown> = {}) {
  return registrationRequestSchema.parse({
    email: 'student@mpei.ru',
    password: 'very-long-password',
    formalRole: 'student',
    profile: {
      fullName: 'Иван Иванов',
      specialization: 'Энергетика',
      timezone: 'Europe/Moscow',
      institute: 'ИЭТ',
      course: 2,
    },
    consents: [
      { documentType: 'age_18', documentVersion: 'local-v1', accepted: true },
      { documentType: 'user_terms', documentVersion: 'local-v1', accepted: true },
      { documentType: 'personal_data', documentVersion: 'local-v1', accepted: true },
      {
        documentType: 'public_profile_distribution',
        documentVersion: 'local-v1',
        accepted: true,
      },
    ],
    ...overrides,
  });
}

describe('identity registration rules', () => {
  it('normalizes case and Unicode domain without accepting suffix lookalikes', () => {
    expect(normalizeEmail(' Student@MPEI.RU ')).toBe('student@mpei.ru');
    expect(() =>
      service.validateRegistrationRules(registration({ email: 'student@mpei.ru.evil' })),
    ).toThrow('Для студента или преподавателя');
  });

  it('allows a non-MPEI employer email with employer-shaped profile', () => {
    const value = registration({
      email: 'hr@example.org',
      formalRole: 'employer',
      profile: {
        fullName: 'Анна Петрова',
        specialization: 'Подбор команды',
        timezone: 'Europe/Moscow',
        company: 'Компания',
      },
    });
    expect(service.validateRegistrationRules(value)).toBe('hr@example.org');
  });

  it('rejects missing and outdated independent consent', () => {
    const missing = registration();
    missing.consents[0]!.accepted = false;
    expect(() => service.validateRegistrationRules(missing)).toThrow('исполнилось 18 лет');

    const outdated = registration();
    outdated.consents[1]!.documentVersion = 'old';
    expect(() => service.validateRegistrationRules(outdated)).toThrow('Документы обновились');
  });

  it('rejects role-irrelevant profile fields and unknown input', () => {
    expect(() =>
      registrationRequestSchema.parse({
        ...registration(),
        profile: { ...registration().profile, company: 'Лишнее поле роли' },
      }),
    ).toThrow();
    expect(() => registrationRequestSchema.parse({ ...registration(), extra: true })).toThrow();
  });

  it('rejects an employer-only position supplied for a teacher', () => {
    expect(() =>
      registration({
        email: 'teacher@mpei.ru',
        formalRole: 'teacher',
        profile: {
          fullName: 'Анна Петрова',
          specialization: 'Электроэнергетика',
          timezone: 'Europe/Moscow',
          department: 'Кафедра РЗиАЭ',
          position: 'Доцент',
        },
      }),
    ).toThrow('Заполните только поля');
  });
});

describe('secret envelope and canonical JSON', () => {
  it('round-trips authenticated encrypted secrets', () => {
    const key = '1'.repeat(64);
    const encrypted = encryptSecret(key, 'verification-secret');
    expect(encrypted.toString()).not.toContain('verification-secret');
    expect(decryptSecret(key, encrypted)).toBe('verification-secret');
  });

  it('canonicalizes object key order', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});
