import type { Request, Response, NextFunction } from 'express';
import { tokenService } from '../modules/auth/token.service.js';
import { tokenBlacklistService } from '../modules/auth/token-blacklist.service.js';
import { HttpError } from './errorHandler.js';
import type { AuthContext } from './auth.js';

export type { AuthContext };

/**
 * Access-token authentication middleware.
 * Extracts and validates Bearer JWT access tokens from the Authorization header,
 * checks against the Redis access-token blacklist (failing closed),
 * and attaches verified user context to req.user.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new HttpError(401, 'Authentication required: Missing Authorization header');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1].trim()) {
      throw new HttpError(
        401,
        'Invalid authorization format: Expected "Authorization: Bearer <token>"',
      );
    }

    const token = parts[1].trim();
    const payload = tokenService.verifyAccessToken(token);

    // Immediate access token revocation check via Redis blacklist (fails closed on Redis errors)
    const isRevoked = await tokenBlacklistService.isBlacklisted(payload.jti);
    if (isRevoked) {
      // Allow already-blacklisted tokens on logout to ensure repeated logout calls remain safe and idempotent
      const isLogoutRoute = req.originalUrl?.endsWith('/logout') || req.path?.endsWith('/logout');
      if (!isLogoutRoute) {
        throw new HttpError(401, 'Access token has been revoked');
      }
    }

    req.user = {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
      role: payload.roles.includes('ADMIN') ? 'ADMIN' : 'USER',
      jti: payload.jti,
      exp: payload.exp,
    };

    next();
  } catch (err) {
    next(err);
  }
}
