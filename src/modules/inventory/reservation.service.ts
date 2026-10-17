import { postgresDb } from '../../db/postgres/client.js';
import { ProductRepository, productRepository } from '../products/products.repository.js';
import { ReservationLockService, reservationLockService } from './reservation-lock.service.js';
import { ReservationCacheService, reservationCacheService } from './reservation-cache.service.js';
import { outboxService, OutboxService } from '../events/outbox/outbox.service.js';
import { eventPublisherService, EventPublisherService } from '../events/event-publisher.service.js';
import { PubSubChannel } from '../events/event.types.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type {
  ReservationRecord,
  CreateReservationInput,
  RawReservationRow,
  ReservationStatus,
} from './reservation.types.js';

interface RawInventoryRow {
  id: string;
  product_id: string;
  quantity: number;
  reserved_quantity: number;
}

function toReservationRecord(row: RawReservationRow): ReservationRecord {
  const expiresAtDate = new Date(row.expires_at);
  const isExpired =
    row.status === 'EXPIRED' ||
    (row.status === 'PENDING' && Date.now() >= expiresAtDate.getTime());

  return {
    id: row.id,
    productId: row.product_id,
    quantity: Number(row.quantity),
    status: row.status as ReservationStatus,
    idempotencyKey: row.idempotency_key,
    expiresAt: expiresAtDate.toISOString(),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    isExpired,
  };
}

export class ReservationService {
  private readonly lockService: ReservationLockService;
  private readonly cacheService: ReservationCacheService;
  private readonly productRepo: ProductRepository;
  private readonly outbox: OutboxService;
  private readonly eventPublisher: EventPublisherService;

  constructor(
    lockService: ReservationLockService = reservationLockService,
    cacheService: ReservationCacheService = reservationCacheService,
    productRepo: ProductRepository = productRepository,
    outbox: OutboxService = outboxService,
    eventPublisher: EventPublisherService = eventPublisherService,
  ) {
    this.lockService = lockService;
    this.cacheService = cacheService;
    this.productRepo = productRepo;
    this.outbox = outbox;
    this.eventPublisher = eventPublisher;
  }

  /**
   * Creates a temporary stock reservation hold with TTL and PostgreSQL durability.
   *
   * Consistency protocol:
   * 1. Check idempotency in Redis fast-path and PostgreSQL database.
   * 2. Authoritative PostgreSQL transaction:
   *    - Row-level lock (SELECT ... FOR UPDATE) on inventory row.
   *    - Verify available stock (quantity - reserved_quantity >= requested).
   *    - Atomically increment reserved_quantity in PostgreSQL.
   *    - Insert reservation record with status = 'PENDING' and unique idempotencyKey.
   * 3. On successful commit, populate Redis temporary state (reservation:{id},
   *    reservation:expiry, reservation:idempotency:{key}).
   * 4. If Redis update fails, PostgreSQL durable state remains authoritative.
   */
  public async createReservation(
    productId: string,
    input: CreateReservationInput,
  ): Promise<ReservationRecord> {
    // 1. Fast-path Redis idempotency check
    const cachedReservationId = await this.cacheService.getReservationIdByIdempotencyKey(
      input.idempotencyKey,
    );
    if (cachedReservationId) {
      const existing = await this.findReservationById(cachedReservationId);
      if (existing) {
        logger.info(
          { reservationId: existing.id, idempotencyKey: input.idempotencyKey },
          'Returning existing reservation from Redis fast-path idempotency match',
        );
        return existing;
      }
    }

    // 2. Validate product existence in MySQL authoritative catalog
    const product = await this.productRepo.findById(productId);
    if (!product) {
      throw new HttpError(404, 'Referenced product not found in product catalog');
    }

    // 3. Determine reservation TTL (bounded by min 10s and max configured TTL)
    const rawTtl = input.ttlSeconds ?? env.RESERVATION_DEFAULT_TTL_SECONDS;
    const effectiveTtlSeconds = Math.min(
      Math.max(rawTtl, 10),
      env.RESERVATION_MAX_TTL_SECONDS,
    );
    const expiresAt = new Date(Date.now() + effectiveTtlSeconds * 1000);

    // 4. Authoritative PostgreSQL Transaction
    const reservationRecord = await postgresDb.$transaction(async (tx) => {
      // 4a. Check database idempotency (prevents race condition if two identical requests arrive)
      const existingRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
        `SELECT id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at
         FROM reservations WHERE idempotency_key = $1 LIMIT 1 FOR UPDATE`,
        input.idempotencyKey,
      );

      if (existingRows && existingRows.length > 0) {
        return toReservationRecord(existingRows[0]);
      }

      // 4b. Lock inventory row exclusively using SELECT ... FOR UPDATE
      const invRows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
        `SELECT id, product_id, quantity, reserved_quantity
         FROM inventories WHERE product_id = $1 LIMIT 1 FOR UPDATE`,
        productId,
      );

      if (!invRows || invRows.length === 0) {
        throw new HttpError(404, 'Inventory record not found for product');
      }

      const inv = invRows[0];
      const physicalQty = Number(inv.quantity);
      const reservedQty = Number(inv.reserved_quantity);
      const availableQty = physicalQty - reservedQty;

      if (availableQty < input.quantity) {
        throw new HttpError(
          409,
          `Insufficient inventory available for hold: requested ${input.quantity}, available ${availableQty}`,
        );
      }

      // 4c. Increment reserved_quantity in PostgreSQL
      await tx.$queryRawUnsafe(
        `UPDATE inventories
         SET reserved_quantity = reserved_quantity + $1, updated_at = NOW()
         WHERE id = $2`,
        input.quantity,
        inv.id,
      );

      // 4d. Insert PENDING reservation record
      const insertedRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
        `INSERT INTO reservations (
           id, product_id, quantity, status, idempotency_key, expires_at, created_at, updated_at
         )
         VALUES (gen_random_uuid(), $1, $2, 'PENDING'::"ReservationStatus", $3, $4, NOW(), NOW())
         RETURNING id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at`,
        productId,
        input.quantity,
        input.idempotencyKey,
        expiresAt,
      );

      const record = toReservationRecord(insertedRows[0]);

      // 4e. Record event to PostgreSQL transactional outbox within same transaction
      try {
        const event = this.eventPublisher.createEvent(
          'reservation.created',
          'inventory-service',
          {
            reservationId: record.id,
            productId: record.productId,
            quantity: record.quantity,
            expiresAt: record.expiresAt,
            idempotencyKey: record.idempotencyKey,
          },
        );
        await this.outbox.recordOutboxEvent(tx, event, PubSubChannel.RESERVATIONS);
      } catch (outboxErr) {
        logger.warn(
          { outboxErr, reservationId: record.id },
          'Warning: Failed to record outbox event for reservation creation',
        );
      }

      return record;
    });

    // 5. Post-commit Redis caching (temporary hold metadata, expiry index, idempotency key)
    try {
      await this.cacheService.cacheReservation(reservationRecord, effectiveTtlSeconds);
    } catch (err: unknown) {
      logger.warn(
        { err, reservationId: reservationRecord.id },
        'Non-fatal: Failed to populate Redis reservation cache after durable PostgreSQL commit',
      );
    }

    // 6. Direct post-commit publishing (non-blocking, fast path)
    try {
      const event = this.eventPublisher.createEvent(
        'reservation.created',
        'inventory-service',
        {
          reservationId: reservationRecord.id,
          productId: reservationRecord.productId,
          quantity: reservationRecord.quantity,
          expiresAt: reservationRecord.expiresAt,
          idempotencyKey: reservationRecord.idempotencyKey,
        },
      );
      void this.eventPublisher.publishDomainEvent(PubSubChannel.RESERVATIONS, event);
    } catch (publishErr) {
      logger.warn(
        { publishErr, reservationId: reservationRecord.id },
        'Warning: Post-commit event publish failed; outbox worker will dispatch',
      );
    }

    return reservationRecord;
  }

  /**
   * Durably confirms an active reservation hold.
   *
   * Coordinated by Redis distributed lock and finalized in PostgreSQL transaction.
   * Enforces:
   * - Verification that the hold has not expired (now < expiresAt).
   * - Permanent stock decrement: physical quantity and reserved_quantity are decremented.
   * - Reservation status transitions from PENDING -> CONFIRMED.
   * - Idempotent: repeating confirmation on already CONFIRMED reservation returns existing state.
   */
  public async confirmReservation(reservationId: string): Promise<ReservationRecord> {
    return await this.lockService.withLock(reservationId, async () => {
      const confirmedRecord = await postgresDb.$transaction(async (tx) => {
        // 1. Lock the reservation row exclusively
        const resRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
          `SELECT id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at
           FROM reservations WHERE id = $1 LIMIT 1 FOR UPDATE`,
          reservationId,
        );

        if (!resRows || resRows.length === 0) {
          throw new HttpError(404, 'Reservation record not found');
        }

        const current = resRows[0];
        const status = current.status as ReservationStatus;

        // Idempotent retry: already confirmed
        if (status === 'CONFIRMED') {
          logger.info({ reservationId }, 'Reservation already confirmed; returning idempotent response');
          return toReservationRecord(current);
        }

        if (status === 'CANCELLED') {
          throw new HttpError(409, 'Cannot confirm reservation: hold has been cancelled');
        }

        if (status === 'EXPIRED') {
          throw new HttpError(409, 'Cannot confirm reservation: hold has expired');
        }

        // 2. Check time-based expiration
        const now = new Date();
        const expiresAt = new Date(current.expires_at);

        if (now >= expiresAt) {
          // Hold expired before confirmation arrived: transition to EXPIRED and release reserved quantity
          await tx.$queryRawUnsafe(
            `UPDATE reservations
             SET status = 'EXPIRED'::"ReservationStatus", updated_at = NOW()
             WHERE id = $1`,
            reservationId,
          );

          await tx.$queryRawUnsafe(
            `UPDATE inventories
             SET reserved_quantity = GREATEST(0, reserved_quantity - $1), updated_at = NOW()
             WHERE product_id = $2`,
            Number(current.quantity),
            current.product_id,
          );

          return { expired: true };
        }

        // 3. Lock inventory row and consume stock (decrement physical stock and release reserved_quantity)
        const invRows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
          `SELECT id, product_id, quantity, reserved_quantity
           FROM inventories WHERE product_id = $1 LIMIT 1 FOR UPDATE`,
          current.product_id,
        );

        if (!invRows || invRows.length === 0) {
          throw new HttpError(404, 'Associated inventory record not found');
        }

        const inv = invRows[0];
        const reserveQty = Number(current.quantity);

        await tx.$queryRawUnsafe(
          `UPDATE inventories
           SET quantity = GREATEST(0, quantity - $1),
               reserved_quantity = GREATEST(0, reserved_quantity - $1),
               updated_at = NOW()
           WHERE id = $2`,
          reserveQty,
          inv.id,
        );

        // 4. Update reservation status to CONFIRMED
        const updatedResRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
          `UPDATE reservations
           SET status = 'CONFIRMED'::"ReservationStatus", confirmed_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at`,
          reservationId,
        );

        const confirmedRecord = toReservationRecord(updatedResRows[0]);

        // 5. Record outbox event within transaction
        try {
          const event = this.eventPublisher.createEvent(
            'reservation.confirmed',
            'inventory-service',
            {
              reservationId: confirmedRecord.id,
              productId: confirmedRecord.productId,
              quantity: confirmedRecord.quantity,
              confirmedAt: confirmedRecord.confirmedAt || new Date().toISOString(),
            },
          );
          await this.outbox.recordOutboxEvent(tx, event, PubSubChannel.RESERVATIONS);
        } catch (outboxErr) {
          logger.warn(
            { outboxErr, reservationId },
            'Warning: Failed to record outbox event for reservation confirmation',
          );
        }

        return confirmedRecord;
      });

      if ('expired' in confirmedRecord && (confirmedRecord as { expired?: boolean }).expired) {
        try {
          await this.cacheService.updateStatusOnTerminalTransition(reservationId, 'EXPIRED');
        } catch {
          // ignore cache error
        }
        throw new HttpError(409, 'Reservation hold has expired and cannot be confirmed');
      }

      // 6. Post-commit Redis cleanup
      try {
        await this.cacheService.updateStatusOnTerminalTransition(reservationId, 'CONFIRMED');
      } catch (err: unknown) {
        logger.warn({ err, reservationId }, 'Failed to update Redis cache after reservation confirmation');
      }

      // 7. Post-commit event publishing
      try {
        const event = this.eventPublisher.createEvent(
          'reservation.confirmed',
          'inventory-service',
          {
            reservationId: confirmedRecord.id,
            productId: confirmedRecord.productId,
            quantity: confirmedRecord.quantity,
            confirmedAt: confirmedRecord.confirmedAt || new Date().toISOString(),
          },
        );
        void this.eventPublisher.publishDomainEvent(PubSubChannel.RESERVATIONS, event);
      } catch (publishErr) {
        logger.warn(
          { publishErr, reservationId },
          'Warning: Failed to publish reservation.confirmed event post-commit',
        );
      }

      return confirmedRecord;
    });
  }

  /**
   * Cancels an active reservation hold and releases reserved stock.
   *
   * Coordinated by Redis distributed lock and finalized in PostgreSQL transaction.
   * Enforces:
   * - Cannot cancel an already CONFIRMED reservation.
   * - Releases reserved_quantity in PostgreSQL exactly once.
   * - Idempotent: repeating cancellation on CANCELLED reservation returns existing state.
   */
  public async cancelReservation(reservationId: string): Promise<ReservationRecord> {
    return await this.lockService.withLock(reservationId, async () => {
      const cancelledRecord = await postgresDb.$transaction(async (tx) => {
        // 1. Lock the reservation row exclusively
        const resRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
          `SELECT id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at
           FROM reservations WHERE id = $1 LIMIT 1 FOR UPDATE`,
          reservationId,
        );

        if (!resRows || resRows.length === 0) {
          throw new HttpError(404, 'Reservation record not found');
        }

        const current = resRows[0];
        const status = current.status as ReservationStatus;

        // Idempotent retry: already cancelled
        if (status === 'CANCELLED') {
          logger.info({ reservationId }, 'Reservation already cancelled; returning idempotent response');
          return toReservationRecord(current);
        }

        if (status === 'CONFIRMED') {
          throw new HttpError(409, 'Cannot cancel reservation: hold has already been confirmed');
        }

        if (status === 'EXPIRED') {
          throw new HttpError(409, 'Cannot cancel reservation: hold has already expired');
        }

        // 2. Release reserved stock back to available pool
        const reserveQty = Number(current.quantity);
        await tx.$queryRawUnsafe(
          `UPDATE inventories
           SET reserved_quantity = GREATEST(0, reserved_quantity - $1), updated_at = NOW()
           WHERE product_id = $2`,
          reserveQty,
          current.product_id,
        );

        // 3. Mark reservation as CANCELLED
        const updatedResRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
          `UPDATE reservations
           SET status = 'CANCELLED'::"ReservationStatus", cancelled_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at`,
          reservationId,
        );

        const cancelledRecord = toReservationRecord(updatedResRows[0]);

        // 4. Record outbox event within transaction
        try {
          const event = this.eventPublisher.createEvent(
            'reservation.cancelled',
            'inventory-service',
            {
              reservationId: cancelledRecord.id,
              productId: cancelledRecord.productId,
              quantity: cancelledRecord.quantity,
              cancelledAt: cancelledRecord.cancelledAt || new Date().toISOString(),
            },
          );
          await this.outbox.recordOutboxEvent(tx, event, PubSubChannel.RESERVATIONS);
        } catch (outboxErr) {
          logger.warn(
            { outboxErr, reservationId },
            'Warning: Failed to record outbox event for reservation cancellation',
          );
        }

        return cancelledRecord;
      });

      // 5. Post-commit Redis cleanup
      try {
        await this.cacheService.updateStatusOnTerminalTransition(reservationId, 'CANCELLED');
      } catch (err: unknown) {
        logger.warn({ err, reservationId }, 'Failed to update Redis cache after reservation cancellation');
      }

      // 6. Post-commit event publishing
      try {
        const event = this.eventPublisher.createEvent(
          'reservation.cancelled',
          'inventory-service',
          {
            reservationId: cancelledRecord.id,
            productId: cancelledRecord.productId,
            quantity: cancelledRecord.quantity,
            cancelledAt: cancelledRecord.cancelledAt || new Date().toISOString(),
          },
        );
        void this.eventPublisher.publishDomainEvent(PubSubChannel.RESERVATIONS, event);
      } catch (publishErr) {
        logger.warn(
          { publishErr, reservationId },
          'Warning: Failed to publish reservation.cancelled event post-commit',
        );
      }

      return cancelledRecord;
    });
  }

  /**
   * Retrieves authoritative reservation state from PostgreSQL.
   */
  public async getReservation(reservationId: string): Promise<ReservationRecord> {
    const record = await this.findReservationById(reservationId);
    if (!record) {
      throw new HttpError(404, 'Reservation record not found');
    }
    return record;
  }

  /**
   * Reconciles and expires an individual reservation hold whose deadline has passed.
   * Invoked by background recovery workers or during explicit expiry processing.
   *
   * Returns true if the reservation was transitioned to EXPIRED and inventory was released,
   * or false if the reservation was already finalized, not expired, or locked.
   */
  public async expireReservation(reservationId: string): Promise<boolean> {
    const lockResult = await this.lockService.acquireLock(reservationId, 3000);
    if (!lockResult.acquired || !lockResult.token) {
      logger.debug({ reservationId }, 'Skipping expiry reconciliation: reservation is currently locked');
      return false;
    }

    try {
      const expired = await postgresDb.$transaction(async (tx) => {
        const resRows = await tx.$queryRawUnsafe<RawReservationRow[]>(
          `SELECT id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at
           FROM reservations WHERE id = $1 LIMIT 1 FOR UPDATE`,
          reservationId,
        );

        if (!resRows || resRows.length === 0) {
          return false;
        }

        const current = resRows[0];
        if (current.status !== 'PENDING') {
          return false;
        }

        const now = new Date();
        const expiresAt = new Date(current.expires_at);
        if (now < expiresAt) {
          // Deadline has not passed yet
          return false;
        }

        // Transition status to EXPIRED
        await tx.$queryRawUnsafe(
          `UPDATE reservations
           SET status = 'EXPIRED'::"ReservationStatus", updated_at = NOW()
           WHERE id = $1`,
          reservationId,
        );

        // Release reserved stock in PostgreSQL
        const reserveQty = Number(current.quantity);
        await tx.$queryRawUnsafe(
          `UPDATE inventories
           SET reserved_quantity = GREATEST(0, reserved_quantity - $1), updated_at = NOW()
           WHERE product_id = $2`,
          reserveQty,
          current.product_id,
        );

        // Record outbox event within transaction
        try {
          const event = this.eventPublisher.createEvent(
            'reservation.expired',
            'inventory-service',
            {
              reservationId,
              productId: current.product_id,
              quantity: reserveQty,
              expiredAt: new Date().toISOString(),
            },
          );
          await this.outbox.recordOutboxEvent(tx, event, PubSubChannel.RESERVATIONS);
        } catch (outboxErr) {
          logger.warn(
            { outboxErr, reservationId },
            'Warning: Failed to record outbox event for reservation expiration',
          );
        }

        return true;
      });

      if (expired) {
        await this.cacheService.updateStatusOnTerminalTransition(reservationId, 'EXPIRED');
        logger.info({ reservationId }, 'Successfully expired reservation hold and released stock');

        // Post-commit event publishing
        try {
          const event = this.eventPublisher.createEvent(
            'reservation.expired',
            'inventory-service',
            {
              reservationId,
              expiredAt: new Date().toISOString(),
            },
          );
          void this.eventPublisher.publishDomainEvent(PubSubChannel.RESERVATIONS, event);
        } catch (publishErr) {
          logger.warn(
            { publishErr, reservationId },
            'Warning: Failed to publish reservation.expired event post-commit',
          );
        }
      } else {
        // If not pending anymore, ensure it is removed from the Redis expiry index
        await this.cacheService.removeFromExpiryIndex(reservationId);
      }

      return expired;
    } finally {
      await this.lockService.releaseLock(reservationId, lockResult.token);
    }
  }

  /**
   * Internal helper to find reservation by ID in PostgreSQL.
   */
  public async findReservationById(reservationId: string): Promise<ReservationRecord | null> {
    try {
      const rows = await postgresDb.$queryRawUnsafe<RawReservationRow[]>(
        `SELECT id, product_id, quantity, status, idempotency_key, expires_at, confirmed_at, cancelled_at, created_at, updated_at
         FROM reservations WHERE id = $1 LIMIT 1`,
        reservationId,
      );

      if (!rows || rows.length === 0) {
        return null;
      }

      return toReservationRecord(rows[0]);
    } catch (err: unknown) {
      logger.error({ err, reservationId }, 'Error querying reservation by ID from PostgreSQL');
      throw err;
    }
  }
}

export const reservationService = new ReservationService();
