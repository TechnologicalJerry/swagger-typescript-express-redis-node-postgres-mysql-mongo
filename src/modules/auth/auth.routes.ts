import { Router } from 'express';
import { authController } from './auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimiter, otpRateLimiter } from '../../middleware/rateLimiter.js';

export const authRoutes: Router = Router();

/**
 * POST /api/auth/login
 * Authenticates user credentials, sets up a Redis refresh session, and issues token pair.
 * Protected by sliding-window auth rate limiter.
 */
authRoutes.post('/login', authRateLimiter, authController.login);

/**
 * POST /api/auth/refresh
 * Validates refresh token, confirms PostgreSQL account status, and atomically rotates session.
 * Protected by sliding-window auth rate limiter.
 */
authRoutes.post('/refresh', authRateLimiter, authController.refresh);

/**
 * POST /api/auth/logout
 * Revokes refresh-token session(s) in Redis and blacklists the access token.
 */
authRoutes.post('/logout', authenticate, authController.logout);

/**
 * GET /api/auth/me
 * Retrieves authenticated caller profile from PostgreSQL.
 */
authRoutes.get('/me', authenticate, authController.me);

/**
 * POST /api/auth/email-verification/request
 * Issues a short-lived verification OTP and sends via email.
 * Protected by sliding-window OTP rate limiter.
 */
authRoutes.post(
  '/email-verification/request',
  otpRateLimiter,
  authController.requestEmailVerification,
);

/**
 * POST /api/auth/email-verification/verify
 * Atomically verifies and consumes the OTP and marks user's email verified.
 * Protected by sliding-window OTP rate limiter.
 */
authRoutes.post('/email-verification/verify', otpRateLimiter, authController.verifyEmail);

/**
 * POST /api/auth/password-reset/request
 * Issues a short-lived password reset OTP and sends via email.
 * Protected by sliding-window OTP rate limiter.
 */
authRoutes.post('/password-reset/request', otpRateLimiter, authController.requestPasswordReset);

/**
 * POST /api/auth/password-reset/verify
 * Atomically verifies OTP, updates password in PostgreSQL, and revokes active sessions.
 * Protected by sliding-window OTP rate limiter.
 */
authRoutes.post('/password-reset/verify', otpRateLimiter, authController.verifyPasswordReset);
