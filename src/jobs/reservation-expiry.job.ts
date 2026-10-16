import { postgresDb } from '../db/postgres/client.js';
import { ReservationCacheService, reservationCacheService } from '../modules/inventory/reservation-cache.service.js';
import { ReservationService, reservationService } from '../modules/inventory/reservation.service.js';
import { logger } from '../config/logger.js';
import type { ReservationExpiryJobResult } from '../modules/inventory/reservation.types.js';

export class ReservationExpiryJob {
  private readonly cacheService: ReservationCacheService;
  private readonly service: ReservationService;

  constructor(
    cacheService: ReservationCacheService = reservationCacheService,
    service: ReservationService = reservationService,
  ) {
    this.cacheService = cacheService;
    this.service = service;
  }

  /**
   * Reconciles expired reservation holds between Redis and PostgreSQL.
   *
   * Dual-source recovery strategy:
   * 1. Reads expired candidates from Redis sorted set index (reservation:expiry, score <= now).
   * 2. Reads expired candidates from PostgreSQL (status = 'PENDING' AND expires_at <= NOW()).
   *    This guarantees recovery even if Redis was restarted, key TTL expired, or network dropped.
   * 3. Deduplicates IDs and executes idempotent state transitions in PostgreSQL with inventory release.
   */
  public async runExpiryReconciliation(batchSize: number = 50): Promise<ReservationExpiryJobResult> {
    const nowMs = Date.now();
    const errors: string[] = [];
    let expiredCount = 0;

    try {
      // 1. Discover expired candidates from Redis sorted set index
      const redisExpiredIds = await this.cacheService.findExpiredReservationIds(nowMs, batchSize);

      // 2. Discover expired candidates from PostgreSQL durable store
      const pgRows = await postgresDb.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM reservations
         WHERE status = 'PENDING'::"ReservationStatus" AND expires_at <= NOW()
         ORDER BY expires_at ASC
         LIMIT $1`,
        batchSize,
      );
      const pgExpiredIds = pgRows ? pgRows.map((r) => r.id) : [];

      // 3. Deduplicate candidate IDs
      const candidateIds = Array.from(new Set([...redisExpiredIds, ...pgExpiredIds]));

      if (candidateIds.length === 0) {
        return {
          status: 'NO_OP',
          scannedCount: 0,
          expiredCount: 0,
        };
      }

      logger.info(
        { candidateCount: candidateIds.length, redisCount: redisExpiredIds.length, pgCount: pgExpiredIds.length },
        'Starting reservation expiry reconciliation batch',
      );

      // 4. Process each candidate with distributed locking and conditional transition
      for (const id of candidateIds) {
        try {
          const transitioned = await this.service.expireReservation(id);
          if (transitioned) {
            expiredCount++;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, reservationId: id }, 'Failed to reconcile expired reservation hold');
          errors.push(`Reservation ${id}: ${errMsg}`);
        }
      }

      return {
        status: errors.length > 0 ? 'PARTIAL_FAILURE' : 'SUCCESS',
        scannedCount: candidateIds.length,
        expiredCount,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (err: unknown) {
      logger.error({ err }, 'Unhandled error running reservation expiry reconciliation job');
      return {
        status: 'PARTIAL_FAILURE',
        scannedCount: 0,
        expiredCount,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }
}

export const reservationExpiryJob = new ReservationExpiryJob();
