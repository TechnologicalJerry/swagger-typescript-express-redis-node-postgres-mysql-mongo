import { z } from 'zod';

export const createReservationSchema = z
  .object({
    quantity: z
      .coerce
      .number()
      .int('Quantity must be an integer')
      .positive('Quantity must be greater than zero'),
    idempotencyKey: z
      .string()
      .trim()
      .min(1, 'Idempotency key is required')
      .max(128, 'Idempotency key must not exceed 128 characters'),
    ttlSeconds: z
      .coerce
      .number()
      .int('TTL must be an integer')
      .min(10, 'TTL must be at least 10 seconds')
      .max(86400, 'TTL must not exceed 86400 seconds')
      .optional(),
  })
  .strict();

export const reservationIdParamSchema = z.object({
  reservationId: z.string().trim().uuid('Invalid reservation ID format'),
});

export type CreateReservationDto = z.infer<typeof createReservationSchema>;
export type ReservationIdParamDto = z.infer<typeof reservationIdParamSchema>;
