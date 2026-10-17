import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { logger } from '../../config/logger.js';
import type {
  ReservationRecord,
  CachedReservation,
  ReservationStatus,
} from './reservation.types.js';

export class ReservationCacheService {
  private readonly redis: Redis;

  constructor(redisInstance: Redis = redis) {
    this.redis = redisInstance;
  }

  /**
   * Generates key for temporary reservation metadata.
   * Pattern: reservation:{reservationId}
   */
  public getReservationKey(reservationId: string): string {
    return `reservation:${reservationId}`;
  }

  /**
   * Generates key for the expiry sorted set index.
   * Pattern: reservation:expiry
   */
  public getExpirySetKey(): string {
    return 'reservation:expiry';
  }

  /**
   * Generates key for idempotent reservation creation mapping.
   * Pattern: reservation:idempotency:{idempotencyKey}
   */
  public getIdempotencyKey(idempotencyKey: string): string {
    return `reservation:idempotency:${idempotencyKey}`;
  }

  /**
   * Caches temporary reservation state in Redis using a pipelined atomic batch:
   * 1. SET reservation:{id} <json> EX <ttlSeconds>
   *    - Stores fast-lookup hold metadata.
   * 2. ZADD reservation:expiry <expiresAtEpochMs> <reservationId>
   *    - Sorted set index for bounded expiration discovery without unbounded KEYS or SCAN.
   * 3. SET reservation:idempotency:{idempotencyKey} <reservationId> EX <ttlSeconds> NX
   *    - Fast-path idempotency check to avoid database load on immediate duplicate retries.
   */
  public async cacheReservation(
    reservation: ReservationRecord,
    ttlSeconds: number,
  ): Promise<void> {
    const resKey = this.getReservationKey(reservation.id);
    const expiryKey = this.getExpirySetKey();
    const idempKey = this.getIdempotencyKey(reservation.idempotencyKey);
    const expiresAtMs = new Date(reservation.expiresAt).getTime();

    const cachedData: CachedReservation = {
      id: reservation.id,
      productId: reservation.productId,
      quantity: reservation.quantity,
      status: reservation.status,
      expiresAt: reservation.expiresAt,
    };

    try {
      const pipeline = this.redis.pipeline();
      pipeline.set(resKey, JSON.stringify(cachedData), 'EX', ttlSeconds);
      pipeline.zadd(expiryKey, expiresAtMs, reservation.id);
      pipeline.set(idempKey, reservation.id, 'EX', ttlSeconds);
      await pipeline.exec();

      logger.debug(
        { reservationId: reservation.id, ttlSeconds, expiresAtMs },
        'Successfully cached temporary reservation hold in Redis',
      );
    } catch (err: unknown) {
      // Non-blocking warning: PostgreSQL is the authoritative source of truth.
      logger.warn(
        { err, reservationId: reservation.id },
        'Warning: Failed to cache reservation hold in Redis; durable state remains safe in PostgreSQL',
      );
    }
  }

  /**
   * Retrieves cached reservation metadata from Redis.
   */
  public async getCachedReservation(reservationId: string): Promise<CachedReservation | null> {
    const key = this.getReservationKey(reservationId);
    try {
      const data = await this.redis.get(key);
      if (!data) return null;
      return JSON.parse(data) as CachedReservation;
    } catch (err: unknown) {
      logger.warn({ err, reservationId }, 'Failed to read cached reservation from Redis');
      return null;
    }
  }

  /**
   * Checks if an idempotency key maps to an existing reservation ID in Redis.
   */
  public async getReservationIdByIdempotencyKey(idempotencyKey: string): Promise<string | null> {
    const key = this.getIdempotencyKey(idempotencyKey);
    try {
      return await this.redis.get(key);
    } catch (err: unknown) {
      logger.warn({ err, idempotencyKey }, 'Failed to lookup idempotency key in Redis');
      return null;
    }
  }

  /**
   * Updates cached reservation status and removes the reservation from the expiry sorted set.
   * Called during terminal transitions (CONFIRMED, CANCELLED, EXPIRED).
   */
  public async updateStatusOnTerminalTransition(
    reservationId: string,
    newStatus: ReservationStatus,
  ): Promise<void> {
    const resKey = this.getReservationKey(reservationId);
    const expiryKey = this.getExpirySetKey();

    try {
      const existing = await this.getCachedReservation(reservationId);
      const pipeline = this.redis.pipeline();

      // Always remove from expiry index so cleanup scheduler does not process finished reservations
      pipeline.zrem(expiryKey, reservationId);

      if (existing) {
        existing.status = newStatus;
        // Keep terminal metadata for a brief grace period (e.g. 60 seconds) for fast reads
        pipeline.set(resKey, JSON.stringify(existing), 'EX', 60);
      } else {
        pipeline.del(resKey);
      }

      await pipeline.exec();
      logger.debug({ reservationId, newStatus }, 'Updated terminal reservation state in Redis');
    } catch (err: unknown) {
      logger.warn({ err, reservationId, newStatus }, 'Failed to update terminal reservation state in Redis');
    }
  }

  /**
   * Removes a reservation from the expiry sorted set.
   */
  public async removeFromExpiryIndex(reservationId: string): Promise<void> {
    const expiryKey = this.getExpirySetKey();
    try {
      await this.redis.zrem(expiryKey, reservationId);
    } catch (err: unknown) {
      logger.warn({ err, reservationId }, 'Failed to remove reservation from expiry index');
    }
  }

  /**
   * Queries the expiry sorted set for reservations whose score (expiry timestamp) is <= nowMs.
   * Uses ZRANGEBYSCORE with LIMIT to guarantee bounded, non-blocking execution.
   */
  public async findExpiredReservationIds(
    nowMs: number = Date.now(),
    limit: number = 50,
  ): Promise<string[]> {
    const expiryKey = this.getExpirySetKey();
    try {
      // ZRANGEBYSCORE reservation:expiry -inf nowMs LIMIT 0 limit
      const ids = await this.redis.zrangebyscore(expiryKey, '-inf', nowMs, 'LIMIT', 0, limit);
      return ids;
    } catch (err: unknown) {
      logger.error({ err }, 'Error querying expired reservations from Redis sorted set');
      return [];
    }
  }

  /**
   * Deletes temporary reservation key from Redis.
   */
  public async deleteReservation(reservationId: string): Promise<void> {
    const resKey = this.getReservationKey(reservationId);
    const expiryKey = this.getExpirySetKey();
    try {
      await this.redis.pipeline().del(resKey).zrem(expiryKey, reservationId).exec();
    } catch (err: unknown) {
      logger.warn({ err, reservationId }, 'Failed to delete reservation key from Redis');
    }
  }
}

export const reservationCacheService = new ReservationCacheService();
