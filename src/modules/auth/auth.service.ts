import bcrypt from 'bcrypt';
import { userRepository, type UserRepository } from '../user/user.repository.js';
import { toSafeUser } from '../user/user.service.js';
import type { SafeUser } from '../user/user.types.js';
import { tokenService, type TokenService } from './token.service.js';
import { sessionService, type SessionService } from './session.service.js';
import { tokenBlacklistService, type TokenBlacklistService } from './token-blacklist.service.js';
import { eventPublisherService, EventPublisherService } from '../events/event-publisher.service.js';
import { PubSubChannel } from '../events/event.types.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../config/logger.js';
import type { AuthTokens, LoginCredentials } from './auth.types.js';

export class AuthService {
  private readonly userRepo: UserRepository;
  private readonly tokenSvc: TokenService;
  private readonly sessionSvc: SessionService;
  private readonly blacklistSvc: TokenBlacklistService;
  private readonly eventPublisher: EventPublisherService;

  constructor(
    userRepo: UserRepository = userRepository,
    tokenSvc: TokenService = tokenService,
    sessionSvc: SessionService = sessionService,
    blacklistSvc: TokenBlacklistService = tokenBlacklistService,
    eventPublisher: EventPublisherService = eventPublisherService,
  ) {
    this.userRepo = userRepo;
    this.tokenSvc = tokenSvc;
    this.sessionSvc = sessionSvc;
    this.blacklistSvc = blacklistSvc;
    this.eventPublisher = eventPublisher;
  }

  /**
   * Authenticates a user using email and password, checks account status in PostgreSQL,
   * creates a Redis refresh-token session, and issues a token pair.
   */
  public async login(
    credentials: LoginCredentials,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<{ tokens: AuthTokens; user: SafeUser }> {
    const normalizedEmail = credentials.email.trim().toLowerCase();
    const user = await this.userRepo.findByEmail(normalizedEmail);

    // Uniform credential rejection prevents user enumeration
    if (!user) {
      try {
        const event = this.eventPublisher.createEvent(
          'auth.login.failed',
          'auth-service',
          {
            email: normalizedEmail,
            reason: 'INVALID_CREDENTIALS',
            ipAddress: metadata?.ipAddress,
            userAgent: metadata?.userAgent,
          },
        );
        void this.eventPublisher.publishDomainEvent(PubSubChannel.AUTH, event);
      } catch (eventErr) {
        logger.warn({ eventErr }, 'Failed to publish auth.login.failed event');
      }
      throw new HttpError(401, 'Invalid email or password');
    }

    const isMatch = await bcrypt.compare(credentials.password, user.passwordHash);
    if (!isMatch) {
      try {
        const event = this.eventPublisher.createEvent(
          'auth.login.failed',
          'auth-service',
          {
            email: normalizedEmail,
            reason: 'INVALID_CREDENTIALS',
            ipAddress: metadata?.ipAddress,
            userAgent: metadata?.userAgent,
          },
        );
        void this.eventPublisher.publishDomainEvent(PubSubChannel.AUTH, event);
      } catch (eventErr) {
        logger.warn({ eventErr }, 'Failed to publish auth.login.failed event');
      }
      throw new HttpError(401, 'Invalid email or password');
    }

    // Reject deactivated or inactive accounts
    if (user.status === 'DEACTIVATED') {
      try {
        const event = this.eventPublisher.createEvent(
          'auth.login.failed',
          'auth-service',
          {
            email: normalizedEmail,
            reason: 'ACCOUNT_DEACTIVATED',
            ipAddress: metadata?.ipAddress,
            userAgent: metadata?.userAgent,
          },
        );
        void this.eventPublisher.publishDomainEvent(PubSubChannel.AUTH, event);
      } catch (eventErr) {
        logger.warn({ eventErr }, 'Failed to publish auth.login.failed event');
      }
      throw new HttpError(403, 'Account is deactivated. Please contact support.');
    }

    const roles = user.roles.map((r) => r.role.name);
    const { tokens, refreshJti } = this.tokenSvc.generateTokens({
      id: user.id,
      email: user.email,
      roles,
    });

    // Create session in Redis with 2-session FIFO eviction limit
    try {
      await this.sessionSvc.createSession(user.id, refreshJti, metadata);
    } catch (sessionErr) {
      if (sessionErr instanceof HttpError) throw sessionErr;
      throw new HttpError(500, 'Session store unavailable');
    }

    // Publish auth.login.succeeded domain event
    try {
      const event = this.eventPublisher.createEvent(
        'auth.login.succeeded',
        'auth-service',
        {
          userId: user.id,
          email: user.email,
          ipAddress: metadata?.ipAddress,
          userAgent: metadata?.userAgent,
        },
      );
      void this.eventPublisher.publishDomainEvent(PubSubChannel.AUTH, event);
    } catch (eventErr) {
      logger.warn({ eventErr, userId: user.id }, 'Failed to publish auth.login.succeeded event');
    }

    return {
      tokens,
      user: toSafeUser(user),
    };
  }

  /**
   * Rotates a refresh token: verifies JWT claims, re-checks PostgreSQL user status,
   * performs atomic rotation in Redis, and handles replay detection.
   */
  public async refresh(
    refreshToken: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthTokens> {
    const payload = this.tokenSvc.verifyRefreshToken(refreshToken);

    // Recheck active account status in PostgreSQL source of truth
    const user = await this.userRepo.findById(payload.sub);
    if (!user || user.status === 'DEACTIVATED') {
      // Invalidate the session in Redis if user is missing or deactivated
      await this.sessionSvc.revokeSession(payload.sub, payload.jti);
      throw new HttpError(401, 'User account is inactive or no longer exists');
    }

    const roles = user.roles.map((r) => r.role.name);
    const newTokens = this.tokenSvc.generateTokens({
      id: user.id,
      email: user.email,
      roles,
    });

    // Atomically swap old session for new session
    const rotated = await this.sessionSvc.rotateSession(
      user.id,
      payload.jti,
      newTokens.refreshJti,
      metadata,
    );

    if (!rotated) {
      const isReplay = await this.sessionSvc.isRotated(payload.jti);
      if (isReplay) {
        // Token replay/reuse detected: token was already rotated!
        // Invalidate all active sessions for the user to mitigate token theft.
        await this.sessionSvc.revokeAllUserSessions(user.id);
        throw new HttpError(
          401,
          'Invalid or revoked refresh token. All active sessions have been invalidated for security.',
        );
      }

      // Session was expired or evicted via FIFO session limit
      throw new HttpError(401, 'Invalid or expired refresh token');
    }

    return newTokens.tokens;
  }

  /**
   * Revokes refresh token session(s) and blacklists the current access token.
   * If refreshToken is supplied, revokes that specific session; otherwise revokes all active sessions for the user.
   */
  public async logout(
    userId: string,
    refreshToken?: string,
    accessContext?: { jti: string; exp: number },
  ): Promise<void> {
    // 1. Blacklist current access token in Redis
    if (accessContext?.jti && accessContext?.exp) {
      await this.blacklistSvc.blacklistToken(accessContext.jti, accessContext.exp);
    }

    // 2. Revoke refresh-token session(s) in Redis
    if (refreshToken) {
      try {
        const payload = this.tokenSvc.verifyRefreshToken(refreshToken);
        if (payload.sub === userId) {
          await this.sessionSvc.revokeSession(userId, payload.jti);
          return;
        }
      } catch {
        // If refresh token cannot be verified, fallback to revoking all user sessions
      }
    }

    // Default: revoke all sessions for this user
    await this.sessionSvc.revokeAllUserSessions(userId);
  }

  /**
   * Retrieves authenticated caller's profile from PostgreSQL.
   */
  public async getCurrentUser(userId: string): Promise<SafeUser> {
    const user = await this.userRepo.findById(userId);
    if (!user || user.status === 'DEACTIVATED') {
      throw new HttpError(404, 'User not found or account is deactivated');
    }
    return toSafeUser(user);
  }
}

export const authService = new AuthService();
