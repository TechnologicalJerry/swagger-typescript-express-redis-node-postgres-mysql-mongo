import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { postgresDb } from '../src/db/postgres/client.js';
import { redis } from '../src/db/redis/client.js';
import { productService } from '../src/modules/products/products.service.js';
import { inventoryService } from '../src/modules/inventory/inventory.service.js';
import { reservationService, ReservationService } from '../src/modules/inventory/reservation.service.js';
import { reservationLockService, ReservationLockService } from '../src/modules/inventory/reservation-lock.service.js';
import { reservationCacheService, ReservationCacheService } from '../src/modules/inventory/reservation-cache.service.js';
import { reservationExpiryJob } from '../src/jobs/reservation-expiry.job.js';

import { mysqlDb } from '../src/db/mysql/client.js';

describe('Phase 8 — Reservation Holds with TTL and Distributed Locks', () => {
  const adminId = 'a0000000-0000-0000-0000-000000000001';

  const cleanData = async () => {
    // 1. Clean PostgreSQL reservations and inventories
    try {
      await postgresDb.$executeRawUnsafe('DELETE FROM reservations');
      await postgresDb.$executeRawUnsafe('DELETE FROM inventories');
    } catch {
      // Ignore during write-only phase before migrations are applied
    }

    // 2. Clean MySQL products
    try {
      await mysqlDb.product.deleteMany({});
    } catch {
      // Ignore during cleanup
    }

    // 3. Clean Redis reservation, lock, and rate limit keys
    try {
      const keys = await redis.keys('reservation:*');
      const lockKeys = await redis.keys('lock:reservation:*');
      const rateKeys = await redis.keys('rate:*');
      const allKeys = [...keys, ...lockKeys, ...rateKeys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    } catch {
      // Ignore during cleanup
    }
  };

  beforeEach(async () => {
    await cleanData();
  });

  afterAll(async () => {
    await cleanData();
  });

  describe('1. Reservation Creation, TTL & Validation', () => {
    it('creates a temporary reservation hold with default 10-minute TTL', async () => {
      const product = await productService.createProduct({
        name: 'Reservation Test Item 1',
        price: 49.99,
        sku: 'HOLD-TEST-001',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 50,
      });

      const idempotencyKey = 'idemp-create-001';
      const beforeTime = Date.now();

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 5,
          idempotencyKey,
        });

      const afterTime = Date.now();

      expect(res.status).toBe(201);
      expect(res.body.productId).toBe(product.id);
      expect(res.body.quantity).toBe(5);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.idempotencyKey).toBe(idempotencyKey);
      expect(res.body.confirmedAt).toBeNull();
      expect(res.body.cancelledAt).toBeNull();

      // Verify expiration timestamp matches default TTL (~600 seconds in future)
      const expiresAtMs = new Date(res.body.expiresAt).getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(beforeTime + 590 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(afterTime + 610 * 1000);

      // Verify PostgreSQL inventory reserved_quantity was incremented
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.quantity).toBe(50);
      expect(inv.reservedQuantity).toBe(5);
      expect(inv.availableQuantity).toBe(45);

      // Verify temporary Redis metadata and expiry index
      const cached = await reservationCacheService.getCachedReservation(res.body.id);
      expect(cached).not.toBeNull();
      expect(cached?.status).toBe('PENDING');
      expect(cached?.quantity).toBe(5);

      const idempMatch = await reservationCacheService.getReservationIdByIdempotencyKey(idempotencyKey);
      expect(idempMatch).toBe(res.body.id);
    });

    it('enforces custom TTL clamped between safe bounds', async () => {
      const product = await productService.createProduct({
        name: 'TTL Clamped Product',
        price: 29.99,
        sku: 'HOLD-TEST-002',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 20,
      });

      // Request TTL of 7200 seconds (above maximum of 3600 seconds)
      const res = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 2,
          idempotencyKey: 'idemp-ttl-clamp-001',
          ttlSeconds: 7200,
        });

      expect(res.status).toBe(201);
      const expiresAtMs = new Date(res.body.expiresAt).getTime();
      const expectedMaxExpiry = Date.now() + 3600 * 1000;
      expect(expiresAtMs).toBeLessThanOrEqual(expectedMaxExpiry + 2000);
    });

    it('rejects reservation request when inventory is insufficient with 409 Conflict', async () => {
      const product = await productService.createProduct({
        name: 'Low Stock Product',
        price: 9.99,
        sku: 'HOLD-TEST-003',
        category: 'Goods',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 3,
      });

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 10,
          idempotencyKey: 'idemp-insufficient-001',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('Insufficient inventory');

      // Verify stock untouched
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(3);
    });

    it('rejects invalid inputs with 400 Bad Request', async () => {
      const product = await productService.createProduct({
        name: 'Validation Product',
        price: 15.0,
        sku: 'HOLD-TEST-004',
        category: 'Goods',
      });

      // Non-positive quantity
      const res1 = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: -1,
          idempotencyKey: 'idemp-neg-qty',
        });
      expect(res1.status).toBe(400);

      // Missing idempotency key
      const res2 = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 1,
        });
      expect(res2.status).toBe(400);
    });
  });

  describe('2. Idempotency & Concurrency Safeguards', () => {
    it('returns identical reservation when retried with same idempotency key without double reserving', async () => {
      const product = await productService.createProduct({
        name: 'Idempotent Product',
        price: 99.0,
        sku: 'HOLD-TEST-005',
        category: 'Hardware',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 10,
      });

      const idempotencyKey = 'idemp-duplicate-test-001';

      // First call
      const firstRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 4,
          idempotencyKey,
        });
      expect(firstRes.status).toBe(201);
      const firstId = firstRes.body.id;

      // Second identical call
      const secondRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 4,
          idempotencyKey,
        });

      // Should succeed and return the exact same reservation ID
      expect(secondRes.body.id).toBe(firstId);
      expect(secondRes.body.quantity).toBe(4);

      // Verify inventory reserved quantity was only incremented ONCE
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.reservedQuantity).toBe(4);
      expect(inv.availableQuantity).toBe(6);
    });

    it('prevents overselling when concurrent requests race for the final available stock', async () => {
      const product = await productService.createProduct({
        name: 'Concurrent Race Product',
        price: 120.0,
        sku: 'HOLD-TEST-006',
        category: 'Hardware',
      });

      // Exactly 5 units available in stock
      await inventoryService.createInventory({
        productId: product.id,
        quantity: 5,
      });

      // Launch 3 simultaneous requests for 3 units each (total demand = 9, supply = 5)
      const [res1, res2, res3] = await Promise.all([
        request(app).post(`/api/inventory/${product.id}/reservations`).send({
          quantity: 3,
          idempotencyKey: 'race-key-1',
        }),
        request(app).post(`/api/inventory/${product.id}/reservations`).send({
          quantity: 3,
          idempotencyKey: 'race-key-2',
        }),
        request(app).post(`/api/inventory/${product.id}/reservations`).send({
          quantity: 3,
          idempotencyKey: 'race-key-3',
        }),
      ]);

      const statuses = [res1.status, res2.status, res3.status];
      const successCount = statuses.filter((s) => s === 201).length;
      const conflictCount = statuses.filter((s) => s === 409).length;

      // Exactly one request can reserve 3 units; the other two must fail with 409
      expect(successCount).toBe(1);
      expect(conflictCount).toBe(2);

      const inv = await inventoryService.getInventory(product.id);
      expect(inv.reservedQuantity).toBe(3);
      expect(inv.availableQuantity).toBe(2);
    });
  });

  describe('3. Reservation Confirmation Lifecycle', () => {
    it('confirms a reservation hold and permanently decrements warehouse stock', async () => {
      const product = await productService.createProduct({
        name: 'Confirm Product',
        price: 60.0,
        sku: 'HOLD-TEST-007',
        category: 'Tools',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 20,
      });

      const createRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 6,
          idempotencyKey: 'confirm-test-001',
        });
      const reservationId = createRes.body.id;

      // Confirm reservation
      const confirmRes = await request(app)
        .post(`/api/inventory/reservations/${reservationId}/confirm`)
        .send();

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.id).toBe(reservationId);
      expect(confirmRes.body.status).toBe('CONFIRMED');
      expect(confirmRes.body.confirmedAt).not.toBeNull();

      // Check PostgreSQL inventory: physical quantity decremented by 6, reserved_quantity released
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.quantity).toBe(14); // 20 - 6
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(14);

      // Verify Redis expiry sorted set member was removed
      const expiredIds = await reservationCacheService.findExpiredReservationIds(Date.now() + 1000000);
      expect(expiredIds).not.toContain(reservationId);
    });

    it('is idempotent on repeated confirmation', async () => {
      const product = await productService.createProduct({
        name: 'Repeat Confirm Product',
        price: 80.0,
        sku: 'HOLD-TEST-008',
        category: 'Tools',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 30,
      });

      const createRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 10,
          idempotencyKey: 'repeat-confirm-001',
        });
      const reservationId = createRes.body.id;

      // First confirmation
      const res1 = await request(app).post(`/api/inventory/reservations/${reservationId}/confirm`).send();
      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('CONFIRMED');

      // Second confirmation (idempotent retry)
      const res2 = await request(app).post(`/api/inventory/reservations/${reservationId}/confirm`).send();
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('CONFIRMED');

      // Verify stock was decremented ONLY ONCE
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.quantity).toBe(20); // 30 - 10
      expect(inv.reservedQuantity).toBe(0);
    });

    it('rejects confirmation if hold has expired and releases reserved quantity', async () => {
      const product = await productService.createProduct({
        name: 'Expired Confirm Product',
        price: 45.0,
        sku: 'HOLD-TEST-009',
        category: 'Tools',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 15,
      });

      const createRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 5,
          idempotencyKey: 'expired-confirm-001',
          ttlSeconds: 10,
        });
      const reservationId = createRes.body.id;

      // Artificially update expires_at in PostgreSQL to past
      await postgresDb.$executeRawUnsafe(
        `UPDATE reservations SET expires_at = NOW() - INTERVAL '5 seconds' WHERE id = $1`,
        reservationId,
      );

      // Attempt to confirm expired reservation
      const confirmRes = await request(app)
        .post(`/api/inventory/reservations/${reservationId}/confirm`)
        .send();

      expect(confirmRes.status).toBe(409);
      expect(confirmRes.body.error.message).toContain('expired');

      // Verify status is now EXPIRED and reserved quantity was released
      const checkRes = await request(app).get(`/api/inventory/reservations/${reservationId}`);
      expect(checkRes.body.status).toBe('EXPIRED');

      const inv = await inventoryService.getInventory(product.id);
      expect(inv.quantity).toBe(15);
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(15);
    });
  });

  describe('4. Reservation Cancellation Lifecycle', () => {
    it('cancels an active reservation hold and releases reserved stock back to available pool', async () => {
      const product = await productService.createProduct({
        name: 'Cancel Product',
        price: 35.0,
        sku: 'HOLD-TEST-010',
        category: 'Supplies',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 25,
      });

      const createRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 8,
          idempotencyKey: 'cancel-test-001',
        });
      const reservationId = createRes.body.id;

      // Cancel reservation
      const cancelRes = await request(app)
        .post(`/api/inventory/reservations/${reservationId}/cancel`)
        .send();

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.id).toBe(reservationId);
      expect(cancelRes.body.status).toBe('CANCELLED');
      expect(cancelRes.body.cancelledAt).not.toBeNull();

      // Check PostgreSQL inventory: reserved_quantity returned to 0, availableQuantity returned to 25
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.quantity).toBe(25);
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(25);
    });

    it('is idempotent on repeated cancellation', async () => {
      const product = await productService.createProduct({
        name: 'Repeat Cancel Product',
        price: 35.0,
        sku: 'HOLD-TEST-011',
        category: 'Supplies',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 25,
      });

      const createRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 5,
          idempotencyKey: 'repeat-cancel-001',
        });
      const reservationId = createRes.body.id;

      // First cancellation
      const res1 = await request(app).post(`/api/inventory/reservations/${reservationId}/cancel`).send();
      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('CANCELLED');

      // Second cancellation
      const res2 = await request(app).post(`/api/inventory/reservations/${reservationId}/cancel`).send();
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('CANCELLED');

      // Stock should not be double-released
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.reservedQuantity).toBe(0);
    });

    it('rejects cancellation on an already CONFIRMED reservation with 409 Conflict', async () => {
      const product = await productService.createProduct({
        name: 'Confirmed No Cancel Product',
        price: 50.0,
        sku: 'HOLD-TEST-012',
        category: 'Supplies',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 10,
      });

      const createRes = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 3,
          idempotencyKey: 'confirmed-no-cancel-001',
        });
      const reservationId = createRes.body.id;

      await request(app).post(`/api/inventory/reservations/${reservationId}/confirm`).send();

      // Attempt to cancel confirmed reservation
      const cancelRes = await request(app)
        .post(`/api/inventory/reservations/${reservationId}/cancel`)
        .send();

      expect(cancelRes.status).toBe(409);
      expect(cancelRes.body.error.message).toContain('already been confirmed');
    });
  });

  describe('5. Distributed Lock Semantics & Contention', () => {
    it('acquires lock exclusively and rejects concurrent contender with 409 Conflict', async () => {
      const dummyReservationId = 'd0000000-0000-0000-0000-000000000001';

      // 1. First process acquires lock
      const lock1 = await reservationLockService.acquireLock(dummyReservationId, 5000);
      expect(lock1.acquired).toBe(true);
      expect(lock1.token).not.toBeNull();

      // 2. Second process tries to acquire same lock
      const lock2 = await reservationLockService.acquireLock(dummyReservationId, 5000);
      expect(lock2.acquired).toBe(false);
      expect(lock2.token).toBeNull();

      // 3. Releasing with wrong owner token fails and does NOT delete lock
      const wrongRelease = await reservationLockService.releaseLock(dummyReservationId, 'wrong-token-999');
      expect(wrongRelease).toBe(false);

      // Verify lock still exists in Redis
      const rawStoredToken = await redis.get(reservationLockService.getLockKey(dummyReservationId));
      expect(rawStoredToken).toBe(lock1.token);

      // 4. Releasing with correct owner token succeeds
      const validRelease = await reservationLockService.releaseLock(dummyReservationId, lock1.token!);
      expect(validRelease).toBe(true);

      // Verify lock deleted in Redis
      const deletedCheck = await redis.get(reservationLockService.getLockKey(dummyReservationId));
      expect(deletedCheck).toBeNull();
    });

    it('handles lock expiration without permitting stale release of new holder lock', async () => {
      const dummyReservationId = 'd0000000-0000-0000-0000-000000000002';

      // Worker 1 acquires lock with short TTL (500ms)
      const worker1Lock = await reservationLockService.acquireLock(dummyReservationId, 500);
      expect(worker1Lock.acquired).toBe(true);

      // Artificially simulate TTL expiration by overwriting or deleting
      await redis.del(reservationLockService.getLockKey(dummyReservationId));

      // Worker 2 acquires fresh lock
      const worker2Lock = await reservationLockService.acquireLock(dummyReservationId, 5000);
      expect(worker2Lock.acquired).toBe(true);
      expect(worker2Lock.token).not.toBe(worker1Lock.token);

      // Worker 1 finishes late and tries to release lock using its old token
      const lateRelease = await reservationLockService.releaseLock(dummyReservationId, worker1Lock.token!);
      expect(lateRelease).toBe(false);

      // Verify Worker 2 lock remains intact and was NOT stolen/deleted by Worker 1
      const activeToken = await redis.get(reservationLockService.getLockKey(dummyReservationId));
      expect(activeToken).toBe(worker2Lock.token);

      // Clean up Worker 2 lock
      await reservationLockService.releaseLock(dummyReservationId, worker2Lock.token!);
    });
  });

  describe('6. Background Expiry Reconciliation', () => {
    it('scans and expires pending holds whose deadline has elapsed, releasing reserved stock', async () => {
      const product = await productService.createProduct({
        name: 'Reconciliation Product',
        price: 18.5,
        sku: 'HOLD-TEST-013',
        category: 'Goods',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 40,
      });

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 12,
          idempotencyKey: 'reconciliation-test-001',
          ttlSeconds: 10,
        });
      const reservationId = res.body.id;

      // Artificially set expires_at in PostgreSQL and Redis sorted set to 10 seconds ago
      const pastTime = new Date(Date.now() - 10000);
      await postgresDb.$executeRawUnsafe(
        `UPDATE reservations SET expires_at = $1 WHERE id = $2`,
        pastTime,
        reservationId,
      );
      await redis.zadd(reservationCacheService.getExpirySetKey(), pastTime.getTime(), reservationId);

      // Run background expiry job
      const jobResult = await reservationExpiryJob.runExpiryReconciliation();
      expect(jobResult.status).toBe('SUCCESS');
      expect(jobResult.expiredCount).toBeGreaterThanOrEqual(1);

      // Verify reservation is now EXPIRED
      const updatedRes = await request(app).get(`/api/inventory/reservations/${reservationId}`);
      expect(updatedRes.body.status).toBe('EXPIRED');

      // Verify stock was released back
      const inv = await inventoryService.getInventory(product.id);
      expect(inv.quantity).toBe(40);
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(40);
    });
  });

  describe('7. Resilience & Fault Tolerance', () => {
    it('preserves durable PostgreSQL reservation even if post-commit Redis caching fails', async () => {
      const product = await productService.createProduct({
        name: 'Redis Failure Product',
        price: 75.0,
        sku: 'HOLD-TEST-014',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 10,
      });

      // Mock Redis cacheReservation to simulate network partition
      const cacheSpy = vi
        .spyOn(reservationCacheService, 'cacheReservation')
        .mockRejectedValueOnce(new Error('Redis connection timed out'));

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reservations`)
        .send({
          quantity: 3,
          idempotencyKey: 'redis-failure-test-001',
        });

      // HTTP call still succeeds because PostgreSQL is the authoritative source of truth
      expect(res.status).toBe(201);
      expect(res.body.productId).toBe(product.id);
      expect(res.body.quantity).toBe(3);

      // Verify reservation exists in PostgreSQL
      const dbRecord = await reservationService.getReservation(res.body.id);
      expect(dbRecord).not.toBeNull();
      expect(dbRecord.id).toBe(res.body.id);

      cacheSpy.mockRestore();
    });
  });
});
