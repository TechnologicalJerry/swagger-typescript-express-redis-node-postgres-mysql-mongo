import { Router, type Request, type Response, type NextFunction } from 'express';
import { productController } from './products.controller.js';
import { resolveAuth, requireAdmin } from '../../middleware/auth.js';
import { authenticate } from '../../middleware/authenticate.js';
import { apiRateLimiter } from '../../middleware/rateLimiter.js';
import { HttpError } from '../../middleware/errorHandler.js';

/**
 * Authentication and administrative authorization middleware.
 * Supports standard Bearer JWT authentication via `authenticate` middleware,
 * while allowing development/test identity resolution via `resolveAuth` headers.
 */
export async function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. If dev/test resolveAuth already populated caller context
  if (req.user) {
    return requireAdmin(req, res, next);
  }

  // 2. If Authorization header is present, verify JWT and blacklist
  if (req.headers.authorization) {
    return authenticate(req, res, (err) => {
      if (err) return next(err);
      return requireAdmin(req, res, next);
    });
  }

  // 3. Unauthenticated mutation request rejected
  return next(new HttpError(401, 'Authentication required'));
}

export function createProductRoutes(): Router {
  const router = Router();

  // Resolve dev/test credentials if present
  router.use(resolveAuth);

  /**
   * POST /api/products
   * Creates a product in MySQL and invalidates list cache entries.
   * Requires ADMIN authorization.
   */
  router.post('/', apiRateLimiter, requireAdminAuth, productController.create);

  /**
   * GET /api/products
   * Lists products with bounded pagination, filters, and query-fingerprinted cache.
   * Sets X-Cache: HIT | MISS | BYPASS.
   */
  router.get('/', apiRateLimiter, productController.list);

  /**
   * GET /api/products/trending
   * Retrieves trending products ranked by popularity score in descending order.
   * Defined before /:id to prevent route shadowing.
   */
  router.get('/trending', apiRateLimiter, productController.getTrending);

  /**
   * GET /api/products/:id
   * Retrieves an individual product using Redis Cache-Aside and stampede lock.
   * Sets X-Cache: HIT | MISS | BYPASS.
   */
  router.get('/:id', apiRateLimiter, productController.getById);

  /**
   * GET /api/products/:id/analytics
   * Retrieves product analytics: total views, estimated unique viewers (HyperLogLog),
   * and trending score.
   */
  router.get('/:id/analytics', apiRateLimiter, productController.getAnalytics);

  /**
   * PATCH /api/products/:id
   * Updates product in MySQL and invalidates individual and list caches.
   * Requires ADMIN authorization.
   */
  router.patch('/:id', apiRateLimiter, requireAdminAuth, productController.update);

  /**
   * DELETE /api/products/:id
   * Deletes product from MySQL and invalidates individual and list caches.
   * Requires ADMIN authorization.
   */
  router.delete('/:id', apiRateLimiter, requireAdminAuth, productController.delete);

  return router;
}

export const productsRoutes = createProductRoutes();
