import type { Request, Response, NextFunction } from 'express';
import { authService, type AuthService } from './auth.service.js';
import { otpService, type OtpService } from './otp.service.js';
import { loginSchema, refreshSchema, logoutSchema } from './auth.schema.js';
import {
  requestEmailVerificationSchema,
  verifyEmailSchema,
  requestPasswordResetSchema,
  verifyPasswordResetSchema,
} from './otp.schema.js';
import { HttpError } from '../../middleware/errorHandler.js';

export class AuthController {
  private readonly service: AuthService;
  private readonly otpSvc: OtpService;

  constructor(service: AuthService = authService, otpSvc: OtpService = otpService) {
    this.service = service;
    this.otpSvc = otpSvc;
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
      const accessContext =
        req.user.jti && req.user.exp ? { jti: req.user.jti, exp: req.user.exp } : undefined;

      await this.service.logout(req.user.id, validated.refreshToken, accessContext);

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

  public requestEmailVerification = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const validated = requestEmailVerificationSchema.parse(req.body);
      const result = await this.otpSvc.requestEmailVerification(validated.email);

      res.status(200).json({
        status: 'success',
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  };

  public verifyEmail = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const validated = verifyEmailSchema.parse(req.body);
      await this.otpSvc.verifyEmail(validated.email, validated.otp);

      res.status(200).json({
        status: 'success',
        message: 'Email address verified successfully',
      });
    } catch (err) {
      next(err);
    }
  };

  public requestPasswordReset = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const validated = requestPasswordResetSchema.parse(req.body);
      const result = await this.otpSvc.requestPasswordReset(validated.email);

      res.status(200).json({
        status: 'success',
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  };

  public verifyPasswordReset = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const validated = verifyPasswordResetSchema.parse(req.body);
      await this.otpSvc.verifyPasswordReset(
        validated.email,
        validated.otp,
        validated.newPassword,
      );

      res.status(200).json({
        status: 'success',
        message:
          'Password has been reset successfully. Please log in with your new password.',
      });
    } catch (err) {
      next(err);
    }
  };
}

export const authController = new AuthController();
