import type { Request, Response } from 'express';
import { AuditLogService, auditLogService } from './audit.service.js';
import { auditLogQuerySchema, eventIdParamSchema } from './audit.schema.js';
import { HttpError } from '../../middleware/errorHandler.js';

export class AuditLogController {
  private readonly service: AuditLogService;

  constructor(service: AuditLogService = auditLogService) {
    this.service = service;
  }

  /**
   * GET /api/audit-logs
   * Retrieves paginated audit logs from MongoDB.
   * Requires ADMIN authorization.
   */
  public list = async (req: Request, res: Response): Promise<void> => {
    const filters = auditLogQuerySchema.parse(req.query);
    const result = await this.service.queryAuditLogs(filters);
    res.status(200).json(result);
  };

  /**
   * GET /api/audit-logs/:eventId
   * Retrieves a specific audit log record by its unique event ID.
   * Requires ADMIN authorization.
   */
  public getByEventId = async (req: Request, res: Response): Promise<void> => {
    const params = eventIdParamSchema.parse(req.params);
    const record = await this.service.getAuditLogByEventId(params.eventId);
    if (!record) {
      throw new HttpError(404, 'Audit log entry not found');
    }
    res.status(200).json(record);
  };
}

export const auditLogController = new AuditLogController();
