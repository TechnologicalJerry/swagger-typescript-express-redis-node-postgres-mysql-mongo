import { Router } from 'express';
import { authController } from './auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';

export const authRoutes: Router = Router();

/**
 * POST /api/auth/login
 * Authenticates user credentials, sets up a Redis refresh session, and issues token pair.
 */
authRoutes.post('/login', authController.login);

/**
 * POST /api/auth/refresh
 * Validates refresh token, confirms PostgreSQL account status, and atomically rotates session.
 */
authRoutes.post('/refresh', authController.refresh);

/**
 * POST /api/auth/logout
 * Revokes refresh-token session(s) in Redis.
 */
authRoutes.post('/logout', authenticate, authController.logout);

/**
 * GET /api/auth/me
 * Retrieves authenticated caller profile from PostgreSQL.
 */
authRoutes.get('/me', authenticate, authController.me);
