import { z } from 'zod';

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const optionalText = z.string().trim().min(1).max(200).optional();

export const profileInputSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    specialization: z.string().trim().min(1).max(200),
    timezone: z.string().min(1).max(64).refine(validTimeZone, 'Неизвестный часовой пояс.'),
    institute: optionalText,
    course: z.number().int().min(1).max(6).optional(),
    department: optionalText,
    company: optionalText,
    position: optionalText,
    avatarMediaId: z.uuid().optional(),
  })
  .strict();

const projectSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    url: z.url().max(2048).optional(),
  })
  .strict();

export const resumeInputSchema = z
  .object({
    about: z.string().trim().max(1024),
    projects: z.array(projectSchema).max(10),
    tagIds: z
      .array(z.uuid())
      .max(20)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Теги не должны повторяться.',
      }),
    searchVisible: z.boolean(),
    imageMediaId: z.uuid().optional(),
  })
  .strict();

export const uuidSchema = z.uuid();
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
export const ifMatchSchema = z.string().regex(/^"[0-9]+"$/u);

export type ProfileInputDto = z.infer<typeof profileInputSchema>;
export type ResumeInputDto = z.infer<typeof resumeInputSchema>;
