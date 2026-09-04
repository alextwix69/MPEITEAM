import { z } from 'zod';

export const registrationFormSchema = z
  .object({
    email: z.email('Введите корректный адрес электронной почты.'),
    password: z.string().min(12, 'Пароль должен содержать не менее 12 символов.').max(128),
    formalRole: z.enum(['student', 'teacher', 'employer']),
    fullName: z.string().trim().min(1, 'Укажите ФИО.').max(200),
    specialization: z.string().trim().min(1, 'Укажите специализацию.').max(200),
    institute: z.string().trim().max(200),
    course: z.string(),
    department: z.string().trim().max(200),
    company: z.string().trim().max(200),
    position: z.string().trim().max(200),
    age_18: z.boolean(),
    user_terms: z.boolean(),
    personal_data: z.boolean(),
    public_profile_distribution: z.boolean(),
  })
  .superRefine((value, context) => {
    const required =
      value.formalRole === 'student'
        ? [value.institute, value.course]
        : value.formalRole === 'teacher'
          ? [value.department]
          : [value.company];
    if (required.some((field) => !field)) {
      context.addIssue({
        code: 'custom',
        path: ['formalRole'],
        message: 'Заполните поля выбранной роли.',
      });
    }
  });

export type RegistrationFormValues = z.infer<typeof registrationFormSchema>;
