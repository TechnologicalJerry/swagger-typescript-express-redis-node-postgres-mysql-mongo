import { Router } from 'express';
import { userController } from './user.controller.js';
import { resolveAuth, requireAdmin, requireSelfOrAdmin } from '../../middleware/auth.js';

export function createUserRoutes(): Router {
  const router = Router();

  // Middleware to resolve caller context for authorized endpoints
  router.use(resolveAuth);

  /**
   * POST /api/users
   * Public user registration endpoint.
   * Anyone can register an account; default role assigned is USER.
   */
  router.post('/', userController.create);

  /**
   * GET /api/users
   * Administrative endpoint: lists paginated users with deterministic ordering.
   * Requires ADMIN role.
   */
  router.get('/', requireAdmin, userController.list);

  /**
   * GET /api/users/:id
   * User-scoped or administrative endpoint: retrieves user details by ID.
   * Accessible by the account owner (self) or an administrator.
   */
  router.get('/:id', requireSelfOrAdmin(), userController.getById);

  /**
   * PATCH /api/users/:id
   * User-scoped or administrative endpoint: updates user profile (displayName, email).
   * Accessible by the account owner (self) or an administrator.
   */
  router.patch('/:id', requireSelfOrAdmin(), userController.update);

  /**
   * PATCH /api/users/:id/deactivate
   * User-scoped or administrative endpoint: deactivates an account safely and idempotently.
   * Accessible by the account owner (self) or an administrator.
   */
  router.patch('/:id/deactivate', requireSelfOrAdmin(), userController.deactivate);

  return router;
}

export const userRoutes = createUserRoutes();
