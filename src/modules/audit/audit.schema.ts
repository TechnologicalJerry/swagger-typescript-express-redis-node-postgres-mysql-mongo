import { z } from 'zod';

export const auditLogQuerySchema = z.object({
  eventType: z.string().trim().optional(),
  targetType: z.string().trim().optional(),
  targetId: z.string().trim().optional(),
  actorId: z.string().trim().optional(),
  correlationId: z.string().trim().optional(),
  startDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  endDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const eventIdParamSchema = z.object({
  eventId: z.string().trim().min(1, 'Event ID is required'),
});

export type AuditLogQueryDto = z.infer<typeof auditLogQuerySchema>;
export type EventIdParamDto = z.infer<typeof eventIdParamSchema>;
