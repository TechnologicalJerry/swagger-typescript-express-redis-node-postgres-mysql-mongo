import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { postgresDb } from '../src/db/postgres/client.js';
import { mysqlDb } from '../src/db/mysql/client.js';
import { redis } from '../src/db/redis/client.js';
import { productService } from '../src/modules/products/products.service.js';
import { inventoryService, InventoryService } from '../src/modules/inventory/inventory.service.js';
import { postgresStockService, PostgresStockService } from '../src/modules/inventory/postgres-stock.service.js';
import { redisStockService, RedisStockService } from '../src/modules/inventory/redis-stock.service.js';

describe('Phase 7 — Inventory Management and Atomic Stock Operations', () => {
  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const regularUserId = 'b0000000-0000-0000-0000-000000000002';

  const cleanInventoryData = async () => {
    // 1. Clean PostgreSQL inventories
    try {
      await postgresDb.$executeRawUnsafe('DELETE FROM inventories');
    } catch {
      // Ignore if table not yet migrated during write-only phase
    }

    // 2. Clean MySQL products
    try {
      await mysqlDb.product.deleteMany({});
    } catch {
      // Ignore during cleanup
    }

    // 3. Clean Redis stock and rate limit keys
    try {
      const stockKeys = await redis.keys('stock:*');
      const rateKeys = await redis.keys('rate:*');
      const allKeys = [...stockKeys, ...rateKeys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    } catch {
      // Ignore during test cleanup
    }
  };

  beforeEach(async () => {
    await cleanInventoryData();
  });

  afterAll(async () => {
    await cleanInventoryData();
  });

  describe('1. Inventory Creation & Authoritative Lookup', () => {
    it('creates an inventory record for an existing product in PostgreSQL', async () => {
      const product = await productService.createProduct({
        name: 'Inventory Test Product',
        price: 99.99,
        sku: 'TEST-INV-001',
        category: 'Hardware',
      });

      const res = await request(app)
        .post('/api/inventory')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          productId: product.id,
          quantity: 100,
        });

      expect(res.status).toBe(201);
      expect(res.body.productId).toBe(product.id);
      expect(res.body.quantity).toBe(100);
      expect(res.body.reservedQuantity).toBe(0);
      expect(res.body.availableQuantity).toBe(100);

      // Verify Redis stock key was initialized with SET NX
      const redisStock = await redisStockService.getCurrentStock(product.id);
      expect(redisStock).toBe(100);
    });

    it('rejects inventory creation for nonexistent products with 404', async () => {
      const nonExistentProductId = '00000000-0000-0000-0000-000000000099';

      const res = await request(app)
        .post('/api/inventory')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          productId: nonExistentProductId,
          quantity: 50,
        });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Referenced product not found');
    });

    it('rejects duplicate inventory records for the same product with 409 Conflict', async () => {
      const product = await productService.createProduct({
        name: 'Duplicate Inventory Product',
        price: 25.0,
        sku: 'TEST-INV-002',
        category: 'General',
      });

      // First creation succeeds
      const firstRes = await request(app)
        .post('/api/inventory')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          productId: product.id,
          quantity: 20,
        });
      expect(firstRes.status).toBe(201);

      // Duplicate creation fails
      const duplicateRes = await request(app)
        .post('/api/inventory')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          productId: product.id,
          quantity: 30,
        });
      expect(duplicateRes.status).toBe(409);
      expect(duplicateRes.body.error.message).toContain('already exists');
    });

    it('rejects negative initial quantity with 400 Validation Error', async () => {
      const product = await productService.createProduct({
        name: 'Negative Quantity Product',
        price: 15.0,
        sku: 'TEST-INV-003',
        category: 'General',
      });

      const res = await request(app)
        .post('/api/inventory')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          productId: product.id,
          quantity: -10,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Validation failed');
    });

    it('rejects unauthenticated or non-admin inventory creation', async () => {
      const unauthRes = await request(app).post('/api/inventory').send({
        productId: 'some-id',
        quantity: 10,
      });
      expect(unauthRes.status).toBe(401);

      const forbiddenRes = await request(app)
        .post('/api/inventory')
        .set('x-user-id', regularUserId)
        .set('x-user-role', 'USER')
        .send({
          productId: 'some-id',
          quantity: 10,
        });
      expect(forbiddenRes.status).toBe(403);
    });

    it('retrieves authoritative inventory details via GET /api/inventory/:productId', async () => {
      const product = await productService.createProduct({
        name: 'Lookup Inventory Product',
        price: 45.0,
        sku: 'TEST-INV-004',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 75,
      });

      const res = await request(app).get(`/api/inventory/${product.id}`);
      expect(res.status).toBe(200);
      expect(res.body.productId).toBe(product.id);
      expect(res.body.quantity).toBe(75);
      expect(res.body.reservedQuantity).toBe(0);
      expect(res.body.availableQuantity).toBe(75);
    });
  });

  describe('2. Inventory Adjustment & Reserved Stock Invariant', () => {
    it('adjusts physical stock quantity in PostgreSQL under row-level lock', async () => {
      const product = await productService.createProduct({
        name: 'Adjust Stock Product',
        price: 60.0,
        sku: 'TEST-INV-005',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 50,
      });

      const res = await request(app)
        .patch(`/api/inventory/${product.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({ quantity: 80 });

      expect(res.status).toBe(200);
      expect(res.body.quantity).toBe(80);
      expect(res.body.availableQuantity).toBe(80);

      // Verify Redis stock key was updated to match
      const redisStock = await redisStockService.getCurrentStock(product.id);
      expect(redisStock).toBe(80);
    });

    it('rejects stock adjustment below currently reserved quantity with 409 Conflict', async () => {
      const product = await productService.createProduct({
        name: 'Reserved Invariant Product',
        price: 35.0,
        sku: 'TEST-INV-006',
        category: 'Supplies',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 50,
      });

      // Reserve 20 units in PostgreSQL
      await inventoryService.reserveStockPostgres(product.id, 20);

      // Attempting to adjust total physical stock to 15 (less than 20 reserved) must fail
      const res = await request(app)
        .patch(`/api/inventory/${product.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({ quantity: 15 });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('currently reserved quantity is 20');
    });
  });

  describe('3. PostgreSQL Atomic Decrement with SELECT ... FOR UPDATE', () => {
    it('successfully decrements stock within a transaction and updates available quantity', async () => {
      const product = await productService.createProduct({
        name: 'Decrement Target Product',
        price: 110.0,
        sku: 'TEST-INV-007',
        category: 'Tools',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 30,
      });

      const res = await request(app)
        .post(`/api/inventory/${product.id}/decrement`)
        .send({ amount: 10 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.previousAvailable).toBe(30);
      expect(res.body.newAvailable).toBe(20);
      expect(res.body.inventory.quantity).toBe(20);
      expect(res.body.mode).toBe('POSTGRES_ROW_LOCK');

      // Database verification
      const record = await inventoryService.getInventory(product.id);
      expect(record.quantity).toBe(20);
    });

    it('rejects decrement exceeding available stock with 409 Conflict', async () => {
      const product = await productService.createProduct({
        name: 'Exceeding Decrement Product',
        price: 40.0,
        sku: 'TEST-INV-008',
        category: 'Tools',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 5,
      });

      const res = await request(app)
        .post(`/api/inventory/${product.id}/decrement`)
        .send({ amount: 10 });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('Insufficient stock');

      // Stock should remain untouched
      const record = await inventoryService.getInventory(product.id);
      expect(record.quantity).toBe(5);
    });

    it('prevents negative stock and overselling under concurrent decrement requests', async () => {
      const product = await productService.createProduct({
        name: 'Concurrency Decrement Product',
        price: 55.0,
        sku: 'TEST-INV-009',
        category: 'Electronics',
      });

      // Stock has exactly 5 units
      await inventoryService.createInventory({
        productId: product.id,
        quantity: 5,
      });

      // Fire 5 concurrent requests attempting to decrement 2 units each (total requested = 10, available = 5)
      const responses = await Promise.all([
        request(app).post(`/api/inventory/${product.id}/decrement`).send({ amount: 2 }),
        request(app).post(`/api/inventory/${product.id}/decrement`).send({ amount: 2 }),
        request(app).post(`/api/inventory/${product.id}/decrement`).send({ amount: 2 }),
        request(app).post(`/api/inventory/${product.id}/decrement`).send({ amount: 2 }),
        request(app).post(`/api/inventory/${product.id}/decrement`).send({ amount: 2 }),
      ]);

      const successResponses = responses.filter((r) => r.status === 200);
      const conflictResponses = responses.filter((r) => r.status === 409);

      // Exactly 2 requests of 2 units can succeed (4 units total). The rest must receive 409 Conflict
      expect(successResponses.length).toBe(2);
      expect(conflictResponses.length).toBe(3);

      // Final stock must be exactly 1, never negative
      const finalInventory = await inventoryService.getInventory(product.id);
      expect(finalInventory.quantity).toBe(1);
    });
  });

  describe('4. PostgreSQL Reservation & Advisory Locking Demonstration', () => {
    it('reserves stock using row-level lock (SELECT ... FOR UPDATE)', async () => {
      const product = await productService.createProduct({
        name: 'Row Lock Reserve Product',
        price: 80.0,
        sku: 'TEST-INV-010',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 40,
      });

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reserve-postgres`)
        .send({ amount: 15, useAdvisoryLock: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.previousAvailable).toBe(40);
      expect(res.body.newAvailable).toBe(25);
      expect(res.body.inventory.quantity).toBe(40); // physical stock remains 40
      expect(res.body.inventory.reservedQuantity).toBe(15);
      expect(res.body.mode).toBe('POSTGRES_ROW_LOCK');
    });

    it('reserves stock using transaction-scoped advisory lock (pg_advisory_xact_lock)', async () => {
      const product = await productService.createProduct({
        name: 'Advisory Lock Reserve Product',
        price: 85.0,
        sku: 'TEST-INV-011',
        category: 'Electronics',
      });

      await inventoryService.createInventory({
        productId: product.id,
        quantity: 50,
      });

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reserve-postgres`)
        .send({ amount: 20, useAdvisoryLock: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.previousAvailable).toBe(50);
      expect(res.body.newAvailable).toBe(30);
      expect(res.body.inventory.reservedQuantity).toBe(20);
      expect(res.body.mode).toBe('POSTGRES_ADVISORY_LOCK');
      expect(res.body.message).toContain('pg_advisory_xact_lock');
    });
  });

  describe('5. Redis Lua Atomic Stock Reservation Demonstration', () => {
    it('atomically reserves stock in Redis using Lua script and DECRBY', async () => {
      const product = await productService.createProduct({
        name: 'Redis Lua Target Product',
        price: 15.0,
        sku: 'TEST-INV-012',
        category: 'General',
      });

      // Seed Redis stock key with 25 units
      await redis.set(`stock:${product.id}`, '25');

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reserve-redis`)
        .send({ amount: 10 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.requestedAmount).toBe(10);
      expect(res.body.remainingStock).toBe(15);
      expect(res.body.mode).toBe('REDIS_LUA');

      // Verify in Redis
      const remaining = await redis.get(`stock:${product.id}`);
      expect(remaining).toBe('15');
    });

    it('rejects Redis reservation when stock is insufficient with 409 Conflict', async () => {
      const product = await productService.createProduct({
        name: 'Insufficient Redis Stock Product',
        price: 18.0,
        sku: 'TEST-INV-013',
        category: 'General',
      });

      await redis.set(`stock:${product.id}`, '5');

      const res = await request(app)
        .post(`/api/inventory/${product.id}/reserve-redis`)
        .send({ amount: 10 });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('Insufficient stock in Redis');

      // Redis stock remains untouched
      expect(await redis.get(`stock:${product.id}`)).toBe('5');
    });

    it('auto-initializes missing Redis stock key from PostgreSQL available stock and succeeds', async () => {
      const product = await productService.createProduct({
        name: 'Auto Init Redis Stock Product',
        price: 22.0,
        sku: 'TEST-INV-014',
        category: 'General',
      });

      // Create PostgreSQL record with 50 units
      await inventoryService.createInventory({
        productId: product.id,
        quantity: 50,
      });

      // Deliberately delete Redis key to simulate cache eviction or cold start
      await redis.del(`stock:${product.id}`);

      // Request should auto-initialize from PostgreSQL and reserve 15 units
      const res = await request(app)
        .post(`/api/inventory/${product.id}/reserve-redis`)
        .send({ amount: 15 });

      expect(res.status).toBe(200);
      expect(res.body.remainingStock).toBe(35);

      // Verify in Redis
      expect(await redis.get(`stock:${product.id}`)).toBe('35');
    });

    it('prevents negative stock under concurrent Redis Lua reservation requests', async () => {
      const product = await productService.createProduct({
        name: 'Concurrent Redis Lua Product',
        price: 30.0,
        sku: 'TEST-INV-015',
        category: 'General',
      });

      // Seed 6 units in Redis
      await redis.set(`stock:${product.id}`, '6');

      // 4 concurrent requests trying to reserve 3 units each (requested = 12, available = 6)
      const responses = await Promise.all([
        request(app).post(`/api/inventory/${product.id}/reserve-redis`).send({ amount: 3 }),
        request(app).post(`/api/inventory/${product.id}/reserve-redis`).send({ amount: 3 }),
        request(app).post(`/api/inventory/${product.id}/reserve-redis`).send({ amount: 3 }),
        request(app).post(`/api/inventory/${product.id}/reserve-redis`).send({ amount: 3 }),
      ]);

      const successCount = responses.filter((r) => r.status === 200).length;
      const conflictCount = responses.filter((r) => r.status === 409).length;

      expect(successCount).toBe(2); // 2 * 3 = 6 units
      expect(conflictCount).toBe(2);

      // Remaining stock must be exactly 0, never negative
      expect(await redis.get(`stock:${product.id}`)).toBe('0');
    });

    it('rejects invalid amounts (negative, zero, or non-integer) with 400', async () => {
      const product = await productService.createProduct({
        name: 'Invalid Amount Product',
        price: 10.0,
        sku: 'TEST-INV-016',
        category: 'General',
      });

      const invalidAmounts = [-5, 0, 1.5];

      for (const amount of invalidAmounts) {
        const res = await request(app)
          .post(`/api/inventory/${product.id}/reserve-redis`)
          .send({ amount });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('Validation failed');
      }
    });
  });
});
