import { z } from 'zod';

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const profileSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    specialization: z.string().trim().min(1).max(200),
    timezone: z.string().min(1).max(64).refine(validTimeZone, 'Неизвестный часовой пояс.'),
    institute: z.string().trim().min(1).max(200).optional(),
    course: z.number().int().min(1).max(6).optional(),
    department: z.string().trim().min(1).max(200).optional(),
    company: z.string().trim().min(1).max(200).optional(),
    position: z.string().trim().min(1).max(200).optional(),
    avatarMediaId: z.uuid().optional(),
  })
  .strict();

export const registrationRequestSchema = z
  .object({
    email: z.email().max(320),
    password: z.string().min(12).max(128),
    formalRole: z.enum(['student', 'teacher', 'employer']),
    profile: profileSchema,
    consents: z
      .array(
        z
          .object({
            documentType: z.enum([
              'age_18',
              'user_terms',
              'personal_data',
              'public_profile_distribution',
            ]),
            documentVersion: z.string().min(1).max(64),
            accepted: z.boolean(),
          })
          .strict(),
      )
      .max(4),
  })
  .strict()
  .superRefine((value, context) => {
    const profile = value.profile;
    const invalid =
      (value.formalRole === 'student' &&
        (!profile.institute ||
          profile.course === undefined ||
          profile.department !== undefined ||
          profile.company !== undefined ||
          profile.position !== undefined)) ||
      (value.formalRole === 'teacher' &&
        (!profile.department ||
          profile.institute !== undefined ||
          profile.course !== undefined ||
          profile.company !== undefined ||
          profile.position !== undefined)) ||
      (value.formalRole === 'employer' &&
        (!profile.company ||
          profile.institute !== undefined ||
          profile.course !== undefined ||
          profile.department !== undefined));
    if (invalid) {
      context.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'Заполните только поля, соответствующие выбранной роли.',
      });
    }
  });

export const tokenRequestSchema = z.object({ token: z.string().min(32).max(2048) }).strict();

export const loginRequestSchema = z
  .object({ email: z.email().max(320), password: z.string().min(1).max(128) })
  .strict();
export const passwordResetRequestSchema = z.object({ email: z.email().max(320) }).strict();
export const passwordResetConfirmSchema = tokenRequestSchema.extend({
  password: z.string().min(12).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

export const emailRequestSchema = z.object({ email: z.email().max(320).optional() }).strict();

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);

export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;
export type TokenRequest = z.infer<typeof tokenRequestSchema>;
export type EmailRequest = z.infer<typeof emailRequestSchema>;
