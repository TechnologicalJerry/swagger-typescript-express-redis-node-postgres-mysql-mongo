import { z } from 'zod';

export const createUserSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'Display name is required')
      .max(100, 'Display name cannot exceed 100 characters'),
    email: z.string().trim().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password cannot exceed 72 characters'),
  })
  .strict();

export const updateUserSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'Display name cannot be empty')
      .max(100, 'Display name cannot exceed 100 characters')
      .optional(),
    email: z.string().trim().email('Invalid email address').optional(),
  })
  .strict()
  .refine(
    (data) => data.displayName !== undefined || data.email !== undefined,
    'At least one field (displayName or email) must be provided for update',
  );

export const userIdParamSchema = z.object({
  id: z.string().uuid('Invalid user ID format: must be a valid UUID'),
});

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1, 'Page must be at least 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'Limit must be at least 1')
    .max(100, 'Limit cannot exceed 100')
    .default(10),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
