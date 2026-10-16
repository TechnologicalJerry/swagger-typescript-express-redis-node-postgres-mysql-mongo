import { Router, type Request, type Response, type NextFunction } from 'express';
import { auditLogController } from './audit.controller.js';
import { resolveAuth, requireAdmin } from '../../middleware/auth.js';
import { authenticate } from '../../middleware/authenticate.js';
import { apiRateLimiter } from '../../middleware/rateLimiter.js';
import { HttpError } from '../../middleware/errorHandler.js';

export async function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.user) {
    return requireAdmin(req, res, next);
  }

  if (req.headers.authorization) {
    return authenticate(req, res, (err) => {
      if (err) return next(err);
      return requireAdmin(req, res, next);
    });
  }

  return next(new HttpError(401, 'Authentication required'));
}

export function createAuditRoutes(): Router {
  const router = Router();

  router.use(resolveAuth);

  /**
   * GET /api/audit-logs
   * Retrieves paginated audit logs from MongoDB.
   * Requires ADMIN authorization.
   */
  router.get('/', apiRateLimiter, requireAdminAuth, auditLogController.list);

  /**
   * GET /api/audit-logs/:eventId
   * Retrieves an audit log entry by event ID.
   * Requires ADMIN authorization.
   */
  router.get('/:eventId', apiRateLimiter, requireAdminAuth, auditLogController.getByEventId);

  return router;
}

export const auditRoutes = createAuditRoutes();
