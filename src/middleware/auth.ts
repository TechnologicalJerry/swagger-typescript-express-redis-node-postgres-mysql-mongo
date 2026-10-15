import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { HttpError } from './errorHandler.js';

export interface AuthContext {
  id: string;
  role: 'USER' | 'ADMIN';
  email?: string;
  roles?: string[];
  jti?: string;
  exp?: number;
}

declare module 'express' {
  interface Request {
    user?: AuthContext;
  }
}

/**
 * Development & test authentication resolver.
 * In development and test environments, resolves the caller's identity via
 * x-user-id and x-user-role headers to enable role-based and user-scoped verification.
 * In production mode, client-provided identity headers are strictly ignored and rejected
 * to prevent unauthorized spoofing before full JWT authentication is implemented in Phase 3.
 */
export function resolveAuth(req: Request, _res: Response, next: NextFunction): void {
  if (env.NODE_ENV === 'production') {
    // In production, unauthenticated requests do not have caller identity populated
    return next();
  }

  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'];

  if (typeof userId === 'string' && userId.trim()) {
    const role = userRole === 'ADMIN' ? 'ADMIN' : 'USER';
    req.user = {
      id: userId.trim(),
      role,
    };
  }

  next();
}

/**
 * Middleware ensuring a valid caller context is present.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    throw new HttpError(401, 'Authentication required');
  }
  next();
}

/**
 * Middleware requiring administrative authorization.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    throw new HttpError(401, 'Authentication required');
  }
  if (req.user.role !== 'ADMIN') {
    throw new HttpError(403, 'Forbidden: Administrative privilege required');
  }
  next();
}

/**
 * Middleware allowing either the account owner (self) or an administrator.
 */
export function requireSelfOrAdmin(
  getTargetUserId: (req: Request) => string | undefined = (r) =>
    typeof r.params.id === 'string' ? r.params.id : undefined,
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new HttpError(401, 'Authentication required');
    }
    const targetId = getTargetUserId(req);
    if (req.user.role !== 'ADMIN' && req.user.id !== targetId) {
      throw new HttpError(403, 'Forbidden: Cannot access or modify another user account');
    }
    next();
  };
}
