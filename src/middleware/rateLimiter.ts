import type { Request, Response, NextFunction } from 'express';
import {
  rateLimitService,
  type RateLimitAlgorithm,
} from '../modules/auth/rate-limit.service.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface RateLimiterOptions {
  policy: string;
  maxRequests: number;
  windowSeconds: number;
  algorithm?: RateLimitAlgorithm;
  keyGenerator?: (req: Request) => string;
}

/**
 * Resolves trusted client IP.
 * Relies on Express req.ip (which respects 'trust proxy' configuration) or falls back
 * directly to TCP socket remoteAddress, avoiding unvalidated header spoofing.
 */
export function defaultClientKeyGenerator(req: Request): string {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // Normalize IPv6 mapped IPv4 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
  return ip.replace(/^::ffff:/, '');
}

/**
 * Factory creating Express middleware for Redis rate limiting.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const {
    policy,
    maxRequests,
    windowSeconds,
    algorithm = 'sliding',
    keyGenerator = defaultClientKeyGenerator,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientKey = keyGenerator(req);
      const result = await rateLimitService.checkLimit(
        algorithm,
        policy,
        clientKey,
        maxRequests,
        windowSeconds,
      );

      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', result.remainingRequests.toString());

      if (!result.allowed) {
        logger.warn(
          { policy, clientKey, totalRequests: result.totalRequests, maxRequests },
          'Rate limit exceeded',
        );

        res.setHeader('Retry-After', result.retryAfterSeconds.toString());
        res.status(429).json({
          error: {
            message: 'Too many requests. Please try again later.',
            statusCode: 429,
          },
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Rate limiter for sensitive authentication operations (login, registration, refresh).
 * Uses a sliding-window algorithm for precise burst protection.
 */
export const authRateLimiter = createRateLimiter({
  policy: 'auth',
  maxRequests: env.RATE_LIMIT_AUTH_MAX_REQUESTS,
  windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  algorithm: 'sliding',
});

/**
 * Rate limiter for OTP issuance and verification operations.
 * Uses a sliding-window algorithm with stricter constraints.
 */
export const otpRateLimiter = createRateLimiter({
  policy: 'otp',
  maxRequests: env.RATE_LIMIT_OTP_MAX_REQUESTS,
  windowSeconds: env.RATE_LIMIT_OTP_WINDOW_SECONDS,
  algorithm: 'sliding',
});

/**
 * General API rate limiter for standard authenticated requests.
 * Uses a fixed-window algorithm for high efficiency.
 */
export const apiRateLimiter = createRateLimiter({
  policy: 'api',
  maxRequests: env.RATE_LIMIT_DEFAULT_MAX_REQUESTS,
  windowSeconds: env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS,
  algorithm: 'fixed',
});
