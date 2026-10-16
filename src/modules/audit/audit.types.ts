export interface CreateAuditLogInput {
  eventId: string;
  eventType: string;
  eventVersion?: number;
  occurredAt: Date | string;
  actorId?: string | null;
  targetType: string;
  targetId: string;
  correlationId?: string | null;
  source: string;
  outcome: 'SUCCESS' | 'FAILURE';
  metadata?: Record<string, unknown>;
}

export interface AuditLogRecord {
  id: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  recordedAt: string;
  actorId: string | null;
  targetType: string;
  targetId: string;
  correlationId: string | null;
  source: string;
  outcome: 'SUCCESS' | 'FAILURE';
  metadata: Record<string, unknown>;
}

export interface AuditLogQueryFilters {
  eventType?: string;
  targetType?: string;
  targetId?: string;
  actorId?: string;
  correlationId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedAuditLogsResult {
  items: AuditLogRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
