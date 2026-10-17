import { Router, type Request, type Response, type NextFunction } from 'express';
import { inventoryController } from './inventory.controller.js';
import { reservationController } from './reservation.controller.js';
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

export function createInventoryRoutes(): Router {
  const router = Router();

  router.use(resolveAuth);

  /**
   * Phase 8 Reservation Endpoints
   * NOTE: Static and nested paths (/reservations/:reservationId) MUST precede /:productId
   * to prevent Express from treating "reservations" as a productId route parameter.
   */

  /**
   * GET /api/inventory/reservations/:reservationId
   * Retrieves durable reservation status and expiry metadata.
   */
  router.get('/reservations/:reservationId', apiRateLimiter, reservationController.getById);

  /**
   * POST /api/inventory/reservations/:reservationId/confirm
   * Confirms a temporary reservation hold, permanently consuming stock.
   */
  router.post('/reservations/:reservationId/confirm', apiRateLimiter, reservationController.confirm);

  /**
   * POST /api/inventory/reservations/:reservationId/cancel
   * Cancels a temporary reservation hold and releases reserved stock.
   */
  router.post('/reservations/:reservationId/cancel', apiRateLimiter, reservationController.cancel);

  /**
   * POST /api/inventory/:productId/reservations
   * Creates a temporary stock reservation hold with TTL.
   */
  router.post('/:productId/reservations', apiRateLimiter, reservationController.create);

  /**
   * POST /api/inventory
   * Creates an inventory record for a product.
   * Requires ADMIN authorization.
   */
  router.post('/', apiRateLimiter, requireAdminAuth, inventoryController.create);

  /**
   * GET /api/inventory/:productId
   * Retrieves authoritative inventory record from PostgreSQL.
   */
  router.get('/:productId', apiRateLimiter, inventoryController.getByProductId);

  /**
   * PATCH /api/inventory/:productId
   * Adjusts physical stock quantity in PostgreSQL.
   * Requires ADMIN authorization.
   */
  router.patch('/:productId', apiRateLimiter, requireAdminAuth, inventoryController.adjust);

  /**
   * POST /api/inventory/:productId/decrement
   * Authoritative PostgreSQL atomic stock decrement using SELECT ... FOR UPDATE.
   */
  router.post('/:productId/decrement', apiRateLimiter, inventoryController.decrement);

  /**
   * POST /api/inventory/:productId/reserve-postgres
   * Authoritative PostgreSQL stock reservation using SELECT ... FOR UPDATE or pg_advisory_xact_lock.
   */
  router.post('/:productId/reserve-postgres', apiRateLimiter, inventoryController.reservePostgres);

  /**
   * POST /api/inventory/:productId/reserve-redis
   * Isolated Redis atomic stock reservation demonstration using Lua script.
   */
  router.post('/:productId/reserve-redis', apiRateLimiter, inventoryController.reserveRedis);

  return router;
}

export const inventoryRoutes = createInventoryRoutes();
