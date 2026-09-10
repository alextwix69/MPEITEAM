import { z } from 'zod';

export const notificationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2048).optional(),
    unreadOnly: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    type: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const notificationUpdateSchema = z.object({ read: z.literal(true) }).strict();
export const readAllNotificationsSchema = z
  .object({ before: z.iso.datetime().optional() })
  .strict();
export const uuidSchema = z.uuid();
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
export const ifMatchSchema = z.string().regex(/^"[0-9]+"$/u);

export const moderationResultPayloadSchema = z
  .object({
    recipientAccountId: z.uuid(),
    decisionId: z.uuid(),
    contentType: z.enum(['profile', 'resume']),
    contentId: z.uuid(),
    approved: z.boolean(),
    policyVersion: z.string().min(1).max(100),
    violationCodes: z.array(z.string().min(1).max(100)).max(35),
    reason: z.string().max(2000).optional(),
  })
  .strict();
