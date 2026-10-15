import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IAuditLog {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  recordedAt: Date;
  actorId?: string | null;
  targetType: string;
  targetId: string;
  correlationId?: string | null;
  source: string;
  outcome: 'SUCCESS' | 'FAILURE';
  metadata: Record<string, unknown>;
}

export interface AuditLogDocument extends IAuditLog, Document {
  id: string;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    eventVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    occurredAt: {
      type: Date,
      required: true,
      index: true,
    },
    recordedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    actorId: {
      type: String,
      default: null,
      index: true,
    },
    targetType: {
      type: String,
      required: true,
      index: true,
    },
    targetId: {
      type: String,
      required: true,
      index: true,
    },
    correlationId: {
      type: String,
      default: null,
      index: true,
    },
    source: {
      type: String,
      required: true,
    },
    outcome: {
      type: String,
      enum: ['SUCCESS', 'FAILURE'],
      default: 'SUCCESS',
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: false,
    collection: 'audit_logs',
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Compound indexes for performant audit queries
auditLogSchema.index({ eventType: 1, occurredAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, occurredAt: -1 });
auditLogSchema.index({ actorId: 1, occurredAt: -1 });

export const AuditLogModel: Model<AuditLogDocument> =
  mongoose.models.AuditLog || mongoose.model<AuditLogDocument>('AuditLog', auditLogSchema);
