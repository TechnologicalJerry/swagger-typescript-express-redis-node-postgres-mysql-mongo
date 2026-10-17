import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { LockAcquireResult } from './reservation.types.js';

/**
 * Lua compare-and-delete script for atomic distributed lock release.
 * Releases the lock ONLY if the stored value matches the caller's unique owner token.
 * Single-key design (KEYS[1]) guarantees 100% compatibility with Redis Cluster hash slots.
 *
 * KEYS[1]: lock key (e.g., lock:reservation:{reservationId})
 * ARGV[1]: unique owner token (e.g., UUIDv4)
 *
 * Returns:
 *   1 if the lock was owned by the caller and successfully deleted
 *   0 if the lock was missing or owned by another process (expired or stolen)
 */
export const COMPARE_AND_DELETE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class ReservationLockService {
  private readonly redis: Redis;
  private readonly defaultTtlMs: number;

  constructor(
    redisInstance: Redis = redis,
    defaultTtlMs: number = env.RESERVATION_LOCK_TTL_MS,
  ) {
    this.redis = redisInstance;
    this.defaultTtlMs = Math.min(Math.max(defaultTtlMs, 500), 60000);
  }

  /**
   * Generates the Redis key for reservation locking.
   * Pattern: lock:reservation:{reservationId}
   */
  public getLockKey(reservationId: string): string {
    return `lock:reservation:${reservationId}`;
  }

  /**
   * Attempts to acquire a distributed lock for a reservation.
   *
   * Redis command:
   *   SET lock:reservation:{reservationId} <token> PX <ttlMs> NX
   *
   * Why this command:
   *   - NX ensures mutual exclusion: fails if the key already exists.
   *   - PX sets an automatic TTL in milliseconds to prevent deadlock if the worker crashes.
   *   - The unique owner token prevents subsequent processes or delayed workers from deleting
   *     locks they do not own.
   */
  public async acquireLock(
    reservationId: string,
    ttlMs: number = this.defaultTtlMs,
  ): Promise<LockAcquireResult> {
    const key = this.getLockKey(reservationId);
    const token = crypto.randomUUID();
    const effectiveTtl = Math.min(Math.max(ttlMs, 500), 60000);

    try {
      // SET key token PX effectiveTtl NX
      const result = await this.redis.set(key, token, 'PX', effectiveTtl, 'NX');
      if (result === 'OK') {
        logger.debug({ reservationId, lockKey: key, effectiveTtl }, 'Acquired reservation distributed lock');
        return { acquired: true, token };
      }
      logger.debug({ reservationId, lockKey: key }, 'Failed to acquire reservation lock: already held');
      return { acquired: false, token: null };
    } catch (err: unknown) {
      logger.warn(
        { err, reservationId, lockKey: key },
        'Redis error encountered during reservation lock acquisition; treating as contention',
      );
      return { acquired: false, token: null };
    }
  }

  /**
   * Releases a distributed lock using the atomic compare-and-delete Lua script.
   * Never issues an unconditional DEL to prevent deleting another holder's lock
   * if the caller's TTL has already elapsed.
   */
  public async releaseLock(reservationId: string, token: string): Promise<boolean> {
    const key = this.getLockKey(reservationId);

    try {
      // EVAL script 1 key token
      const result = await this.redis.eval(COMPARE_AND_DELETE_LOCK_LUA, 1, key, token);
      const released = Number(result) === 1;

      if (released) {
        logger.debug({ reservationId, lockKey: key }, 'Safely released reservation distributed lock');
      } else {
        logger.warn(
          { reservationId, lockKey: key },
          'Lock release compare failed: lock was already expired, missing, or acquired by another worker',
        );
      }

      return released;
    } catch (err: unknown) {
      logger.warn(
        { err, reservationId, lockKey: key },
        'Redis error encountered during reservation lock release; lock will expire by TTL',
      );
      return false;
    }
  }

  /**
   * Executes a critical section wrapped with distributed lock acquisition and safe release.
   * Throws HTTP 409 Conflict if lock acquisition fails to prevent concurrent mutation.
   */
  public async withLock<T>(
    reservationId: string,
    operation: (token: string) => Promise<T>,
    ttlMs: number = this.defaultTtlMs,
  ): Promise<T> {
    const lockResult = await this.acquireLock(reservationId, ttlMs);
    if (!lockResult.acquired || !lockResult.token) {
      throw new HttpError(
        409,
        'Reservation is currently locked by a concurrent operation. Please retry.',
      );
    }

    try {
      return await operation(lockResult.token);
    } finally {
      await this.releaseLock(reservationId, lockResult.token);
    }
  }
}

export const reservationLockService = new ReservationLockService();
