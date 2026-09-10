import { z } from 'zod';
import { uploadMimeTypes, uploadOwnerTypes } from '../files.types';

export const uploadCreateSchema = z
  .object({
    contentScope: z.enum(['private_message', 'public_content']),
    ownerType: z.enum(uploadOwnerTypes),
    ownerId: z.uuid(),
    mimeType: z.enum(uploadMimeTypes),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
  })
  .strict();

export const uuidSchema = z.uuid();
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);

export type ParsedUploadCreate = z.infer<typeof uploadCreateSchema>;
