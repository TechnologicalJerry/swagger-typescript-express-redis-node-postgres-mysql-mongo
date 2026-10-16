import { z } from 'zod';

export const domainEventEnvelopeSchema = z.object({
  eventId: z.string().uuid('Event ID must be a valid UUID'),
  eventType: z.string().min(1, 'Event type is required'),
  eventVersion: z.number().int().positive().default(1),
  occurredAt: z.string().datetime({ offset: true }).or(z.string().min(10)),
  correlationId: z.string().optional(),
  producer: z.string().min(1, 'Producer name is required'),
  payload: z.record(z.string(), z.unknown()),
});

export const productCreatedPayloadSchema = z.object({
  productId: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  price: z.number().positive(),
  category: z.string().min(1),
});

export const productUpdatedPayloadSchema = z.object({
  productId: z.string().min(1),
  updatedFields: z.array(z.string()),
});

export const productDeletedPayloadSchema = z.object({
  productId: z.string().min(1),
});

export const inventoryAdjustedPayloadSchema = z.object({
  productId: z.string().min(1),
  previousQuantity: z.number().int().nonnegative(),
  newQuantity: z.number().int().nonnegative(),
  reservedQuantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
});

export const reservationCreatedPayloadSchema = z.object({
  reservationId: z.string().uuid(),
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  expiresAt: z.string(),
  idempotencyKey: z.string().min(1),
});

export const reservationConfirmedPayloadSchema = z.object({
  reservationId: z.string().uuid(),
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  confirmedAt: z.string(),
});

export const reservationCancelledPayloadSchema = z.object({
  reservationId: z.string().uuid(),
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  cancelledAt: z.string(),
});

export const reservationExpiredPayloadSchema = z.object({
  reservationId: z.string().uuid(),
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  expiredAt: z.string(),
});

export const authLoginSucceededPayloadSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});

export const authLoginFailedPayloadSchema = z.object({
  email: z.string().email(),
  reason: z.string().min(1),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});

const SENSITIVE_EVENT_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'otp',
  'secret',
  'authorization',
  'ownertoken',
]);

/**
 * Sanitizes an event payload by stripping or redacting any sensitive data,
 * credentials, authentication tokens, or OTP secrets before publishing.
 */
export function sanitizeEventPayload<T extends Record<string, unknown>>(payload: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_EVENT_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeEventPayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
