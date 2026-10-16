import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';

export class TokenBlacklistService {
  private readonly redis: Redis;

  constructor(redisInstance: Redis = redis) {
    this.redis = redisInstance;
  }

  /**
   * Constructs the Redis key for an access token blacklist entry.
   * Pattern: blacklist:access:{jti}
   */
  public getBlacklistKey(jti: string): string {
    return `blacklist:access:${jti}`;
  }

  /**
   * Adds an access token identifier (jti) to the Redis blacklist with a TTL
   * matching its remaining validity period.
   *
   * @param jti Unique token identifier from the access token payload
   * @param exp Token expiration timestamp in seconds (UNIX epoch)
   */
  public async blacklistToken(jti: string, exp: number): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const remainingTtl = exp - nowSeconds;

    // If the token is already expired, it is naturally invalid and does not require blacklisting
    if (remainingTtl <= 0) {
      return;
    }

    const key = this.getBlacklistKey(jti);

    try {
      // SET key "revoked" EX remainingTtl
      // Stores revocation flag with automated TTL expiration matching the token's remaining lifetime
      await this.redis.set(key, 'revoked', 'EX', remainingTtl);
      logger.info({ jti, ttl: remainingTtl }, 'Access token blacklisted in Redis');
    } catch (err: unknown) {
      logger.error({ err, jti }, 'Failed to blacklist access token in Redis');
      // Fail closed: report failure so caller knows revocation did not succeed
      throw new HttpError(500, 'Failed to revoke token');
    }
  }

  /**
   * Checks whether an access token identifier is present in the Redis blacklist.
   * Fails closed: throws HttpError(500) if Redis is unavailable.
   *
   * @param jti Unique token identifier
   */
  public async isBlacklisted(jti: string): Promise<boolean> {
    const key = this.getBlacklistKey(jti);

    try {
      // EXISTS returns 1 if key exists in Redis, 0 otherwise
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (err: unknown) {
      logger.error({ err, jti }, 'Failed to check token blacklist status in Redis');
      // Fail closed: never treat Redis timeout/error as proof that token is valid
      throw new HttpError(500, 'Authentication service temporarily unavailable');
    }
  }
}

export const tokenBlacklistService = new TokenBlacklistService();
