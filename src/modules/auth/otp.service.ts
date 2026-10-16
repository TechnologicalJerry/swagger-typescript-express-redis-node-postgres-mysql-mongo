import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { userRepository, type UserRepository } from '../user/user.repository.js';
import { sessionService, type SessionService } from './session.service.js';
import { mailerService, type MailerService } from '../../config/mailer.js';
import { OtpVerifyResult, type OtpPurpose } from './otp.types.js';

/**
 * Lua script to verify and consume an OTP atomically.
 * Returns:
 *   1  - Success (OTP matched and consumed)
 *   0  - Invalid OTP (attempts incremented)
 *  -1  - Expired or not found
 *  -2  - Maximum attempts exceeded (OTP invalidated)
 */
const VERIFY_AND_CONSUME_OTP_LUA = `
local otpKey = KEYS[1]
local attemptsKey = KEYS[2]
local expectedHmac = ARGV[1]
local maxAttempts = tonumber(ARGV[2])

-- 1. Check if max attempts already reached
local attempts = tonumber(redis.call('GET', attemptsKey) or '0')
if attempts >= maxAttempts then
  redis.call('DEL', otpKey)
  return -2
end

-- 2. Check if OTP exists
local storedHmac = redis.call('GET', otpKey)
if not storedHmac then
  return -1
end

-- 3. Compare stored verifier with expected verifier
if storedHmac == expectedHmac then
  redis.call('DEL', otpKey)
  redis.call('DEL', attemptsKey)
  return 1
else
  local newAttempts = redis.call('INCR', attemptsKey)
  if newAttempts == 1 then
    local ttl = redis.call('TTL', otpKey)
    if ttl > 0 then
      redis.call('EXPIRE', attemptsKey, ttl)
    end
  end
  if newAttempts >= maxAttempts then
    redis.call('DEL', otpKey)
    return -2
  end
  return 0
end
`;

export class OtpService {
  private readonly redis: Redis;
  private readonly userRepo: UserRepository;
  private readonly sessionSvc: SessionService;
  private readonly mailer: MailerService;
  private readonly secret: string;
  public readonly expirationSeconds: number;
  public readonly length: number;
  public readonly maxAttempts: number;
  public readonly cooldownSeconds: number;

  constructor(
    redisInstance: Redis = redis,
    userRepo: UserRepository = userRepository,
    sessionSvc: SessionService = sessionService,
    mailer: MailerService = mailerService,
    secret: string = env.OTP_SECRET,
    expirationSeconds: number = env.OTP_EXPIRATION_SECONDS,
    length: number = env.OTP_LENGTH,
    maxAttempts: number = env.OTP_MAX_ATTEMPTS,
    cooldownSeconds: number = env.OTP_COOLDOWN_SECONDS,
  ) {
    this.redis = redisInstance;
    this.userRepo = userRepo;
    this.sessionSvc = sessionSvc;
    this.mailer = mailer;
    this.secret = secret;
    this.expirationSeconds = expirationSeconds;
    this.length = length;
    this.maxAttempts = maxAttempts;
    this.cooldownSeconds = cooldownSeconds;
  }

  /**
   * Generates a cryptographically secure numeric OTP string of configured length.
   */
  public generateNumericOtp(): string {
    const min = Math.pow(10, this.length - 1);
    const max = Math.pow(10, this.length);
    return crypto.randomInt(min, max).toString();
  }

  /**
   * Computes a non-reversible HMAC-SHA256 verifier for the OTP.
   * Never stores the raw OTP in Redis.
   */
  public computeVerifier(userId: string, purpose: OtpPurpose, otp: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${userId}:${purpose}:${otp}`)
      .digest('hex');
  }

  /**
   * Redis key for stored OTP verifier (hash-tagged by userId for cluster slot affinity).
   */
  public getOtpKey(userId: string, purpose: OtpPurpose): string {
    return `otp:{${userId}}:${purpose}`;
  }

  /**
   * Redis key for resend cooldown.
   */
  public getCooldownKey(userId: string, purpose: OtpPurpose): string {
    return `otp:{${userId}}:cooldown:${purpose}`;
  }

  /**
   * Redis key for verification attempt counter.
   */
  public getAttemptsKey(userId: string, purpose: OtpPurpose): string {
    return `otp:{${userId}}:attempts:${purpose}`;
  }

  /**
   * Workflow: Request an email verification code.
   * Returns a generic message to prevent account enumeration.
   */
  public async requestEmailVerification(email: string): Promise<{ message: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const genericResponse = {
      message: 'If an active account exists with this email, a verification code has been sent.',
    };

    const user = await this.userRepo.findByEmail(normalizedEmail);
    if (!user || user.status === 'DEACTIVATED') {
      return genericResponse;
    }

    // Check resend cooldown
    const cooldownKey = this.getCooldownKey(user.id, 'email-verification');
    const inCooldown = await this.redis.exists(cooldownKey);
    if (inCooldown) {
      throw new HttpError(
        429,
        'A verification code was recently sent. Please wait before requesting another.',
      );
    }

    const otp = this.generateNumericOtp();
    const verifier = this.computeVerifier(user.id, 'email-verification', otp);
    const otpKey = this.getOtpKey(user.id, 'email-verification');
    const attemptsKey = this.getAttemptsKey(user.id, 'email-verification');

    try {
      // Store verifier with TTL, set cooldown, reset attempts
      const pipeline = this.redis.pipeline();
      pipeline.set(otpKey, verifier, 'EX', this.expirationSeconds);
      pipeline.set(cooldownKey, '1', 'EX', this.cooldownSeconds);
      pipeline.del(attemptsKey);
      await pipeline.exec();

      await this.mailer.sendEmailVerificationOtp(user.email, otp, user.displayName);
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'Failed to process email verification request');
      throw new HttpError(500, 'Unable to send verification code at this time');
    }

    return genericResponse;
  }

  /**
   * Workflow: Verify email using submitted OTP and update PostgreSQL status.
   */
  public async verifyEmail(email: string, otp: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.userRepo.findByEmail(normalizedEmail);

    if (!user || user.status === 'DEACTIVATED') {
      throw new HttpError(400, 'Invalid or expired verification code');
    }

    const expectedHmac = this.computeVerifier(user.id, 'email-verification', otp.trim());
    const otpKey = this.getOtpKey(user.id, 'email-verification');
    const attemptsKey = this.getAttemptsKey(user.id, 'email-verification');

    const result = (await this.redis.eval(
      VERIFY_AND_CONSUME_OTP_LUA,
      2,
      otpKey,
      attemptsKey,
      expectedHmac,
      this.maxAttempts.toString(),
    )) as number;

    if (result === OtpVerifyResult.SUCCESS) {
      await this.userRepo.markEmailVerified(user.id);
      logger.info({ userId: user.id }, 'Email address successfully verified');
      return;
    }

    if (result === OtpVerifyResult.INVALID_OTP) {
      throw new HttpError(400, 'Invalid verification code');
    }

    if (result === OtpVerifyResult.MAX_ATTEMPTS_EXCEEDED) {
      throw new HttpError(
        400,
        'Maximum verification attempts exceeded. Please request a new code.',
      );
    }

    // EXPIRED_OR_NOT_FOUND (-1)
    throw new HttpError(400, 'Verification code has expired or was already used');
  }

  /**
   * Workflow: Request password reset OTP.
   * Returns a generic message to prevent account enumeration.
   */
  public async requestPasswordReset(email: string): Promise<{ message: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const genericResponse = {
      message: 'If an active account exists with this email, a password reset code has been sent.',
    };

    const user = await this.userRepo.findByEmail(normalizedEmail);
    if (!user || user.status === 'DEACTIVATED') {
      return genericResponse;
    }

    // Check resend cooldown
    const cooldownKey = this.getCooldownKey(user.id, 'password-reset');
    const inCooldown = await this.redis.exists(cooldownKey);
    if (inCooldown) {
      throw new HttpError(
        429,
        'A reset code was recently sent. Please wait before requesting another.',
      );
    }

    const otp = this.generateNumericOtp();
    const verifier = this.computeVerifier(user.id, 'password-reset', otp);
    const otpKey = this.getOtpKey(user.id, 'password-reset');
    const attemptsKey = this.getAttemptsKey(user.id, 'password-reset');

    try {
      const pipeline = this.redis.pipeline();
      pipeline.set(otpKey, verifier, 'EX', this.expirationSeconds);
      pipeline.set(cooldownKey, '1', 'EX', this.cooldownSeconds);
      pipeline.del(attemptsKey);
      await pipeline.exec();

      await this.mailer.sendPasswordResetOtp(user.email, otp, user.displayName);
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'Failed to process password reset request');
      throw new HttpError(500, 'Unable to send password reset code at this time');
    }

    return genericResponse;
  }

  /**
   * Workflow: Verify password reset OTP, hash new password, update PostgreSQL,
   * and revoke all existing refresh-token sessions.
   */
  public async verifyPasswordReset(
    email: string,
    otp: string,
    newPassword: string,
  ): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.userRepo.findByEmail(normalizedEmail);

    if (!user || user.status === 'DEACTIVATED') {
      throw new HttpError(400, 'Invalid or expired reset code');
    }

    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
      throw new HttpError(400, 'Password exceeds maximum length limit of 72 bytes');
    }

    const expectedHmac = this.computeVerifier(user.id, 'password-reset', otp.trim());
    const otpKey = this.getOtpKey(user.id, 'password-reset');
    const attemptsKey = this.getAttemptsKey(user.id, 'password-reset');

    // 1. Verify and consume OTP atomically
    const result = (await this.redis.eval(
      VERIFY_AND_CONSUME_OTP_LUA,
      2,
      otpKey,
      attemptsKey,
      expectedHmac,
      this.maxAttempts.toString(),
    )) as number;

    if (result === OtpVerifyResult.INVALID_OTP) {
      throw new HttpError(400, 'Invalid reset code');
    }

    if (result === OtpVerifyResult.MAX_ATTEMPTS_EXCEEDED) {
      throw new HttpError(
        400,
        'Maximum verification attempts exceeded. Please request a new code.',
      );
    }

    if (result === OtpVerifyResult.EXPIRED_OR_NOT_FOUND) {
      throw new HttpError(400, 'Reset code has expired or was already used');
    }

    // 2. Hash new password and update in PostgreSQL
    const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_WORK_FACTOR);
    await this.userRepo.updatePassword(user.id, passwordHash);

    // 3. Revoke all active refresh sessions for security
    await this.sessionSvc.revokeAllUserSessions(user.id);
    logger.info({ userId: user.id }, 'Password successfully reset and active sessions revoked');
  }
}

export const otpService = new OtpService();
