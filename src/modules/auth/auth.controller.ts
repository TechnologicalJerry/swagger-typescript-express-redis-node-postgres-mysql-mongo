import type { Request, Response, NextFunction } from 'express';
import { authService, type AuthService } from './auth.service.js';
import { loginSchema, refreshSchema, logoutSchema } from './auth.schema.js';
import { HttpError } from '../../middleware/errorHandler.js';

export class AuthController {
  private readonly service: AuthService;

  constructor(service: AuthService = authService) {
    this.service = service;
  }

  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = loginSchema.parse(req.body);
      const metadata = {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.socket.remoteAddress,
      };

      const result = await this.service.login(validated, metadata);

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  public refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = refreshSchema.parse(req.body);
      const metadata = {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.socket.remoteAddress,
      };

      const tokens = await this.service.refresh(validated.refreshToken, metadata);

      res.status(200).json({
        status: 'success',
        data: { tokens },
      });
    } catch (err) {
      next(err);
    }
  };

  public logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new HttpError(401, 'Authentication required');
      }

      const validated = logoutSchema.parse(req.body || {});
      await this.service.logout(req.user.id, validated.refreshToken);

      res.status(200).json({
        status: 'success',
        message: 'Logged out successfully',
      });
    } catch (err) {
      next(err);
    }
  };

  public me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new HttpError(401, 'Authentication required');
      }

      const user = await this.service.getCurrentUser(req.user.id);

      res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (err) {
      next(err);
    }
  };
}

export const authController = new AuthController();
