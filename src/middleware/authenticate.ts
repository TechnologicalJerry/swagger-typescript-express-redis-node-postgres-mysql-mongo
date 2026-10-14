import type { Request, Response, NextFunction } from 'express';
import { tokenService } from '../modules/auth/token.service.js';
import { HttpError } from './errorHandler.js';
import type { AuthContext } from './auth.js';

export type { AuthContext };

/**
 * Access-token authentication middleware.
 * Extracts and validates Bearer JWT access tokens from the Authorization header.
 * Attaches verified user context to req.user.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
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

  req.user = {
    id: payload.sub,
    email: payload.email,
    roles: payload.roles,
    role: payload.roles.includes('ADMIN') ? 'ADMIN' : 'USER',
  };

  next();
}
