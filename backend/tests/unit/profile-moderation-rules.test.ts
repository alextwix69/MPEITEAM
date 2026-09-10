import { describe, expect, it } from 'vitest';
import { profileInputSchema, resumeInputSchema } from '../../src/modules/profiles/profiles.schemas';
import {
  MODERATION_VIOLATION_CODES,
  normalizeViolationCodes,
} from '../../src/modules/trust/policy';

describe('profile and moderation rules', () => {
  it('validates bounded resume content and unique canonical identifiers', () => {
    const valid = resumeInputSchema.parse({
      about: '  Системный инженер  ',
      projects: [{ title: 'Проект', description: 'Описание' }],
      tagIds: [crypto.randomUUID()],
      searchVisible: true,
    });
    expect(valid.about).toBe('Системный инженер');
    expect(() =>
      resumeInputSchema.parse({
        ...valid,
        projects: Array.from({ length: 11 }, () => ({ title: 'Проект', description: 'Описание' })),
      }),
    ).toThrow();
    expect(() =>
      resumeInputSchema.parse({ ...valid, tagIds: [valid.tagIds[0], valid.tagIds[0]] }),
    ).toThrow();
  });

  it('rejects malformed timezones and unknown profile fields', () => {
    expect(() =>
      profileInputSchema.parse({
        fullName: 'Иван Иванов',
        specialization: 'Энергетика',
        timezone: 'Mars/Olympus',
      }),
    ).toThrow();
    expect(() =>
      profileInputSchema.parse({
        fullName: 'Иван Иванов',
        specialization: 'Энергетика',
        timezone: 'Europe/Moscow',
        email: 'private@example.test',
      }),
    ).toThrow();
  });

  it('keeps a stable 35-code policy and normalizes provider output', () => {
    expect(MODERATION_VIOLATION_CODES).toHaveLength(35);
    expect(normalizeViolationCodes(['profanity', 'unknown', 'profanity'])).toEqual([
      'other_illegal_content',
      'profanity',
    ]);
  });
});
