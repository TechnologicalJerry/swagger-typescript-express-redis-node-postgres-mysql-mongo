import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Lua script for ownership-safe atomic lock release.
 * Releases the lock if and only if the stored lock token matches the token provided by the caller.
 * Prevents a slow query from accidentally releasing a lock acquired by another request after TTL expiration.
 */
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class ProductCacheLockService {
  private readonly redis: Redis;
  public readonly lockTtlMs: number;

  constructor(
    redisInstance: Redis = redis,
    lockTtlMs: number = env.PRODUCT_CACHE_LOCK_TTL_MS,
  ) {
    this.redis = redisInstance;
    this.lockTtlMs = lockTtlMs;
  }

  /**
   * Constructs the Redis lock key for cache-stampede coordination.
   * Pattern: lock:cache:product:{productId}
   */
  public getLockKey(productId: string): string {
    return `lock:cache:product:${productId}`;
  }

  /**
   * Attempts to acquire an exclusive lock to re-populate the cache on cache miss.
   * Uses SET NX PX to atomically set the key if not exists with an automatic millisecond TTL.
   *
   * @param productId Target product ID
   * @returns The unique lock token string on success, or null if another request holds the lock
   */
  public async acquireLock(productId: string): Promise<string | null> {
    const lockKey = this.getLockKey(productId);
    const lockToken = crypto.randomUUID();

    try {
      // SET key token NX PX ttlMs
      // NX: Only set the key if it does not already exist
      // PX: Set the specified expire time in milliseconds
      const result = await this.redis.set(lockKey, lockToken, 'PX', this.lockTtlMs, 'NX');

      if (result === 'OK') {
        return lockToken;
      }
      return null;
    } catch (err: unknown) {
      logger.error({ err, productId }, 'Error attempting to acquire product cache stampede lock');
      return null;
    }
  }

  /**
   * Releases the lock atomically using compare-and-delete Lua script.
   * Ensures the lock is only deleted if the caller still owns it.
   */
  public async releaseLock(productId: string, lockToken: string): Promise<boolean> {
    const lockKey = this.getLockKey(productId);

    try {
      const result = await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
      return Number(result) === 1;
    } catch (err: unknown) {
      logger.error({ err, productId, lockToken }, 'Error releasing product cache stampede lock');
      return false;
    }
  }
}

export const productCacheLockService = new ProductCacheLockService();
