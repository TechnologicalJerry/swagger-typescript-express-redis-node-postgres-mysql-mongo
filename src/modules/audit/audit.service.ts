import { AuditLogModel, type AuditLogDocument } from '../../db/mongo/models/audit-log.model.js';
import { logger } from '../../config/logger.js';
import type {
  CreateAuditLogInput,
  AuditLogRecord,
  AuditLogQueryFilters,
  PaginatedAuditLogsResult,
} from './audit.types.js';

const SENSITIVE_KEYS = new Set([
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
 * Recursively sanitizes metadata to ensure sensitive fields, credentials,
 * and tokens are never persisted to MongoDB audit logs.
 */
export function sanitizeAuditMetadata(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      sanitized[key] = sanitizeAuditMetadata(val);
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

function toAuditLogRecord(doc: AuditLogDocument | (Record<string, unknown> & { _id: unknown })): AuditLogRecord {
  const d = doc as Record<string, unknown>;
  const idStr = String(d._id || d.id || '');
  return {
    id: idStr,
    eventId: String(d.eventId),
    eventType: String(d.eventType),
    eventVersion: Number(d.eventVersion ?? 1),
    occurredAt: d.occurredAt instanceof Date ? d.occurredAt.toISOString() : new Date(String(d.occurredAt)).toISOString(),
    recordedAt: d.recordedAt instanceof Date ? d.recordedAt.toISOString() : new Date(String(d.recordedAt)).toISOString(),
    actorId: d.actorId ? String(d.actorId) : null,
    targetType: String(d.targetType),
    targetId: String(d.targetId),
    correlationId: d.correlationId ? String(d.correlationId) : null,
    source: String(d.source),
    outcome: d.outcome === 'FAILURE' ? 'FAILURE' : 'SUCCESS',
    metadata: (d.metadata as Record<string, unknown>) || {},
  };
}

export class AuditLogService {
  /**
   * Persists an audit log record into MongoDB.
   *
   * Idempotency guarantee:
   * The MongoDB collection enforces a unique index on `eventId`. If a duplicate
   * event arrives (e.g. from stream consumer replay or network retry), the Mongo
   * E11000 duplicate key error is caught and handled idempotently without throwing.
   */
  public async recordAuditLog(input: CreateAuditLogInput): Promise<AuditLogRecord | null> {
    const occurredAt = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
    const sanitizedMeta = sanitizeAuditMetadata(input.metadata);

    try {
      const doc = await AuditLogModel.create({
        eventId: input.eventId,
        eventType: input.eventType,
        eventVersion: input.eventVersion ?? 1,
        occurredAt,
        recordedAt: new Date(),
        actorId: input.actorId || null,
        targetType: input.targetType,
        targetId: input.targetId,
        correlationId: input.correlationId || null,
        source: input.source,
        outcome: input.outcome,
        metadata: sanitizedMeta,
      });

      logger.debug(
        { eventId: input.eventId, eventType: input.eventType, targetId: input.targetId },
        'Recorded durable MongoDB audit log',
      );

      return toAuditLogRecord(doc);
    } catch (err: unknown) {
      const errObj = err as { code?: number; message?: string };
      // Handle MongoDB duplicate key error code 11000
      if (errObj.code === 11000 || (errObj.message && errObj.message.includes('E11000 duplicate key error'))) {
        logger.info(
          { eventId: input.eventId, eventType: input.eventType },
          'Duplicate audit event ignored; idempotent handling succeeded',
        );
        const existing = await AuditLogModel.findOne({ eventId: input.eventId }).lean();
        return existing ? toAuditLogRecord(existing as unknown as AuditLogDocument) : null;
      }

      logger.error(
        { err, eventId: input.eventId, eventType: input.eventType },
        'Failed to persist audit log into MongoDB',
      );
      throw err;
    }
  }

  /**
   * Queries paginated audit logs from MongoDB.
   */
  public async queryAuditLogs(filters: AuditLogQueryFilters): Promise<PaginatedAuditLogsResult> {
    const query: Record<string, unknown> = {};

    if (filters.eventType) {
      query.eventType = filters.eventType;
    }
    if (filters.targetType) {
      query.targetType = filters.targetType;
    }
    if (filters.targetId) {
      query.targetId = filters.targetId;
    }
    if (filters.actorId) {
      query.actorId = filters.actorId;
    }
    if (filters.correlationId) {
      query.correlationId = filters.correlationId;
    }

    if (filters.startDate || filters.endDate) {
      const dateQuery: Record<string, Date> = {};
      if (filters.startDate) {
        dateQuery.$gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        dateQuery.$lte = new Date(filters.endDate);
      }
      query.occurredAt = dateQuery;
    }

    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(Math.max(1, filters.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const [total, docs] = await Promise.all([
      AuditLogModel.countDocuments(query),
      AuditLogModel.find(query).sort({ occurredAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const items = docs.map((d) => toAuditLogRecord(d as unknown as AuditLogDocument));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves an audit log record by event ID.
   */
  public async getAuditLogByEventId(eventId: string): Promise<AuditLogRecord | null> {
    const doc = await AuditLogModel.findOne({ eventId }).lean();
    if (!doc) return null;
    return toAuditLogRecord(doc as unknown as AuditLogDocument);
  }
}

export const auditLogService = new AuditLogService();
