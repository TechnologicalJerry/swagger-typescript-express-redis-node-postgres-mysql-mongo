import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthTokens, TokenPayload } from './auth.types.js';

export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly issuer: string;
  private readonly audience: string;
  public readonly accessExpirationSeconds: number;
  public readonly refreshExpirationSeconds: number;

  constructor(
    accessSecret: string = env.JWT_ACCESS_SECRET,
    refreshSecret: string = env.JWT_REFRESH_SECRET,
    issuer: string = env.JWT_ISSUER,
    audience: string = env.JWT_AUDIENCE,
    accessExpirationSeconds: number = env.JWT_ACCESS_EXPIRATION_SECONDS,
    refreshExpirationSeconds: number = env.JWT_REFRESH_EXPIRATION_SECONDS,
  ) {
    this.accessSecret = accessSecret;
    this.refreshSecret = refreshSecret;
    this.issuer = issuer;
    this.audience = audience;
    this.accessExpirationSeconds = accessExpirationSeconds;
    this.refreshExpirationSeconds = refreshExpirationSeconds;
  }

  /**
   * Generates a pair of signed JWTs (access token and refresh token) with separate expiration and unique JTIs.
   */
  public generateTokens(user: { id: string; email: string; roles: string[] }): {
    tokens: AuthTokens;
    accessJti: string;
    refreshJti: string;
  } {
    const accessJti = crypto.randomUUID();
    const refreshJti = crypto.randomUUID();

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        roles: user.roles,
        tokenType: 'ACCESS',
        jti: accessJti,
      },
      this.accessSecret,
      {
        algorithm: 'HS256',
        issuer: this.issuer,
        audience: this.audience,
        expiresIn: this.accessExpirationSeconds,
      },
    );

    const refreshToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        roles: user.roles,
        tokenType: 'REFRESH',
        jti: refreshJti,
      },
      this.refreshSecret,
      {
        algorithm: 'HS256',
        issuer: this.issuer,
        audience: this.audience,
        expiresIn: this.refreshExpirationSeconds,
      },
    );

    return {
      tokens: {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: this.accessExpirationSeconds,
      },
      accessJti,
      refreshJti,
    };
  }

  /**
   * Verifies an access token ensuring valid algorithm, issuer, audience, expiration, and tokenType === 'ACCESS'.
   */
  public verifyAccessToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, this.accessSecret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as jwt.JwtPayload;

      if (decoded.tokenType !== 'ACCESS') {
        throw new HttpError(401, 'Invalid token: Expected an access token');
      }

      if (!decoded.sub || typeof decoded.sub !== 'string') {
        throw new HttpError(401, 'Invalid token: Missing subject claim');
      }

      return {
        sub: decoded.sub,
        iss: decoded.iss as string,
        aud: decoded.aud as string,
        jti: decoded.jti as string,
        iat: decoded.iat as number,
        exp: decoded.exp as number,
        tokenType: 'ACCESS',
        email: (decoded.email as string) || '',
        roles: Array.isArray(decoded.roles) ? (decoded.roles as string[]) : [],
      };
    } catch (err: unknown) {
      if (err instanceof HttpError) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new HttpError(401, 'Access token has expired');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new HttpError(401, `Invalid access token: ${err.message}`);
      }
      throw new HttpError(401, 'Authentication failed');
    }
  }

  /**
   * Verifies a refresh token ensuring valid algorithm, issuer, audience, expiration, and tokenType === 'REFRESH'.
   */
  public verifyRefreshToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, this.refreshSecret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as jwt.JwtPayload;

      if (decoded.tokenType !== 'REFRESH') {
        throw new HttpError(401, 'Invalid token: Expected a refresh token');
      }

      if (!decoded.sub || typeof decoded.sub !== 'string') {
        throw new HttpError(401, 'Invalid token: Missing subject claim');
      }

      return {
        sub: decoded.sub,
        iss: decoded.iss as string,
        aud: decoded.aud as string,
        jti: decoded.jti as string,
        iat: decoded.iat as number,
        exp: decoded.exp as number,
        tokenType: 'REFRESH',
        email: (decoded.email as string) || '',
        roles: Array.isArray(decoded.roles) ? (decoded.roles as string[]) : [],
      };
    } catch (err: unknown) {
      if (err instanceof HttpError) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new HttpError(401, 'Refresh token has expired');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new HttpError(401, `Invalid refresh token: ${err.message}`);
      }
      throw new HttpError(401, 'Authentication failed');
    }
  }
}

export const tokenService = new TokenService();
