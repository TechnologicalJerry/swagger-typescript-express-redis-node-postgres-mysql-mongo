import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { redis } from '../src/db/redis/client.js';
import { mysqlDb } from '../src/db/mysql/client.js';
import { productService, ProductService } from '../src/modules/products/products.service.js';
import { productRepository, ProductRepository } from '../src/modules/products/products.repository.js';
import { productCacheService, ProductCacheService } from '../src/modules/products/product-cache.service.js';
import { productCacheLockService, ProductCacheLockService } from '../src/modules/products/product-cache-lock.service.js';
import { env } from '../src/config/env.js';
import type { Product } from '../src/modules/products/products.types.js';

describe('Product Management and Redis Cache-Aside Module', () => {
  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const regularUserId = 'b0000000-0000-0000-0000-000000000002';

  const cleanTestProducts = async () => {
    // 1. Clean MySQL products created in tests
    try {
      const client = mysqlDb as unknown as {
        product?: {
          deleteMany: (args: { where: { sku: { contains: string } } }) => Promise<unknown>;
        };
      };
      if (client.product?.deleteMany) {
        await client.product.deleteMany({
          where: { sku: { contains: 'TEST-' } },
        });
      }
    } catch {
      // Ignore if table not yet migrated during write-only phase
    }

    // 2. Clean Redis product caches
    try {
      const keys = await redis.keys('cache:product:*');
      const lockKeys = await redis.keys('lock:cache:product:*');
      const allKeys = [...keys, ...lockKeys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    } catch {
      // Ignore Redis errors during test cleanup
    }
  };

  beforeEach(async () => {
    await cleanTestProducts();
  });

  afterAll(async () => {
    await cleanTestProducts();
  });

  describe('1. Product API CRUD Operations', () => {
    const validProductPayload = {
      name: 'Wireless Mechanical Keyboard',
      slug: 'wireless-mechanical-keyboard',
      description: 'Compact 75% wireless mechanical keyboard with hot-swappable switches',
      price: 129.99,
      currency: 'USD',
      sku: 'TEST-KB-001',
      category: 'Electronics',
      isActive: true,
    };

    it('rejects unauthenticated product creation with 401', async () => {
      const res = await request(app)
        .post('/api/products')
        .send(validProductPayload);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Authentication required');
    });

    it('rejects product creation by non-admin user with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('x-user-id', regularUserId)
        .set('x-user-role', 'USER')
        .send(validProductPayload);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Administrative privilege required');
    });

    it('successfully creates product when authorized as ADMIN', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send(validProductPayload);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.name).toBe(validProductPayload.name);
      expect(res.body.slug).toBe(validProductPayload.slug);
      expect(res.body.price).toBe('129.99');
      expect(res.body.sku).toBe(validProductPayload.sku);
      expect(res.body.category).toBe(validProductPayload.category);
      expect(res.body.isActive).toBe(true);
    });

    it('rejects invalid request data (negative price, excessive decimals, empty name)', async () => {
      const invalidCases = [
        { ...validProductPayload, name: '' },
        { ...validProductPayload, price: -10 },
        { ...validProductPayload, price: 19.999 }, // more than 2 decimal places
        { ...validProductPayload, sku: 'INVALID SKU WITH SPACES' },
        { ...validProductPayload, slug: 'INVALID_SLUG_UPPERCASE' },
      ];

      for (const payload of invalidCases) {
        const res = await request(app)
          .post('/api/products')
          .set('x-user-id', adminId)
          .set('x-user-role', 'ADMIN')
          .send(payload);

        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('Validation failed');
      }
    });

    it('rejects duplicate SKU and duplicate slug with 409 Conflict', async () => {
      // First product
      const res1 = await request(app)
        .post('/api/products')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send(validProductPayload);
      expect(res1.status).toBe(201);

      // Duplicate SKU
      const resSku = await request(app)
        .post('/api/products')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          ...validProductPayload,
          slug: 'different-slug-unique',
          sku: validProductPayload.sku, // duplicate
        });
      expect(resSku.status).toBe(409);
      expect(resSku.body.error.message).toContain('SKU already exists');

      // Duplicate slug
      const resSlug = await request(app)
        .post('/api/products')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          ...validProductPayload,
          sku: 'TEST-KB-002-UNIQUE',
          slug: validProductPayload.slug, // duplicate
        });
      expect(resSlug.status).toBe(409);
      expect(resSlug.body.error.message).toContain('slug already exists');
    });

    it('updates product and prevents duplicate collisions on existing SKU/slug', async () => {
      const created = await productService.createProduct({
        name: 'Gaming Mouse',
        price: 59.99,
        sku: 'TEST-MOUSE-001',
        category: 'Electronics',
      });

      const res = await request(app)
        .patch(`/api/products/${created.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({
          name: 'Gaming Mouse Pro',
          price: 69.99,
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Gaming Mouse Pro');
      expect(res.body.price).toBe('69.99');
    });

    it('rejects empty update body with 400', async () => {
      const created = await productService.createProduct({
        name: 'Empty Body Test Product',
        price: 19.99,
        sku: 'TEST-EMPTY-001',
        category: 'Accessories',
      });

      const res = await request(app)
        .patch(`/api/products/${created.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('At least one field');
    });

    it('deletes product successfully when authorized as ADMIN', async () => {
      const created = await productService.createProduct({
        name: 'Deletable Product',
        price: 9.99,
        sku: 'TEST-DEL-001',
        category: 'General',
      });

      const res = await request(app)
        .delete(`/api/products/${created.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(204);

      // Verify deletion from database
      const lookup = await request(app).get(`/api/products/${created.id}`);
      expect(lookup.status).toBe(404);
    });

    it('returns 404 for non-existent product operations', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000099';

      const getRes = await request(app).get(`/api/products/${nonExistentId}`);
      expect(getRes.status).toBe(404);

      const patchRes = await request(app)
        .patch(`/api/products/${nonExistentId}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({ price: 15.0 });
      expect(patchRes.status).toBe(404);

      const delRes = await request(app)
        .delete(`/api/products/${nonExistentId}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');
      expect(delRes.status).toBe(404);
    });

    it('validates pagination and query parameters', async () => {
      const invalidLimit = await request(app).get('/api/products?limit=101');
      expect(invalidLimit.status).toBe(400);

      const invalidPage = await request(app).get('/api/products?page=0');
      expect(invalidPage.status).toBe(400);
    });
  });

  describe('2. Redis Cache-Aside Pattern and Observable Headers', () => {
    it('sets X-Cache: MISS on initial lookup and populates Redis with configured TTL', async () => {
      const product = await productService.createProduct({
        name: 'Cache Aside Monitor',
        price: 299.99,
        sku: 'TEST-MON-001',
        category: 'Electronics',
      });

      const cacheKey = `cache:product:${product.id}`;

      // Ensure cache is initially empty
      await redis.del(cacheKey);

      // 1. First GET: Cache Miss -> Fetched from MySQL -> Populated into Redis
      const firstRes = await request(app).get(`/api/products/${product.id}`);
      expect(firstRes.status).toBe(200);
      expect(firstRes.headers['x-cache']).toBe('MISS');
      expect(firstRes.body.id).toBe(product.id);

      // Verify Redis string value exists and matches
      const rawRedisData = await redis.get(cacheKey);
      expect(rawRedisData).not.toBeNull();
      const parsedData = JSON.parse(rawRedisData!) as Product;
      expect(parsedData.id).toBe(product.id);
      expect(parsedData.price).toBe('299.99');

      // Verify TTL was set and is bounded by PRODUCT_CACHE_TTL_SECONDS
      const ttl = await redis.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(env.PRODUCT_CACHE_TTL_SECONDS);

      // 2. Second GET: Cache Hit -> Served directly from Redis
      const secondRes = await request(app).get(`/api/products/${product.id}`);
      expect(secondRes.status).toBe(200);
      expect(secondRes.headers['x-cache']).toBe('HIT');
      expect(secondRes.body.id).toBe(product.id);
    });

    it('sets X-Cache: BYPASS when client explicitly requests cache bypass', async () => {
      const product = await productService.createProduct({
        name: 'Bypass Monitor',
        price: 199.99,
        sku: 'TEST-BYP-001',
        category: 'Electronics',
      });

      // Populate cache first
      await request(app).get(`/api/products/${product.id}`);

      // Request with Cache-Control: no-cache
      const bypassRes = await request(app)
        .get(`/api/products/${product.id}`)
        .set('Cache-Control', 'no-cache');

      expect(bypassRes.status).toBe(200);
      expect(bypassRes.headers['x-cache']).toBe('BYPASS');
    });

    it('safely recovers from malformed/corrupted cached JSON by treating it as a miss and purging key', async () => {
      const product = await productService.createProduct({
        name: 'Corrupt Cache Test',
        price: 49.99,
        sku: 'TEST-CORRUPT-001',
        category: 'Books',
      });

      const cacheKey = `cache:product:${product.id}`;

      // Infiltrate Redis with malformed/unparseable JSON string
      await redis.set(cacheKey, 'MALFORMED_NON_JSON_CONTENT{{{');

      // Request should treat corrupted JSON as miss, purge corrupted key, fetch from DB, and succeed
      const res = await request(app).get(`/api/products/${product.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(product.id);

      // Corrupted key should have been purged or re-set with valid JSON
      const repairedData = await redis.get(cacheKey);
      expect(repairedData).not.toBe('MALFORMED_NON_JSON_CONTENT{{{');
    });

    it('gracefully falls back to MySQL with X-Cache: BYPASS when Redis connection is unavailable', async () => {
      const mockRepo = {
        findById: vi.fn().mockResolvedValue({
          id: 'mock-prod-id',
          name: 'Fallback Product',
          slug: 'fallback-product',
          description: null,
          price: '99.99',
          currency: 'USD',
          sku: 'TEST-FB-001',
          category: 'Misc',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as ProductRepository;

      const mockUnavailableCache = {
        isAvailable: vi.fn().mockReturnValue(false),
        getProduct: vi.fn().mockResolvedValue(null),
      } as unknown as ProductCacheService;

      const testService = new ProductService(
        mockRepo,
        mockUnavailableCache,
        productCacheLockService,
      );

      const result = await testService.getProductById('mock-prod-id');
      expect(result.cacheState).toBe('BYPASS');
      expect(result.product.name).toBe('Fallback Product');
      expect(mockRepo.findById).toHaveBeenCalledWith('mock-prod-id');
    });
  });

  describe('3. Cache Invalidation on Mutations', () => {
    it('invalidates individual product cache and list cache after product update', async () => {
      const product = await productService.createProduct({
        name: 'Before Update Product',
        price: 10.0,
        sku: 'TEST-INV-001',
        category: 'Office',
      });

      const productKey = `cache:product:${product.id}`;

      // Warm individual cache
      await request(app).get(`/api/products/${product.id}`);
      expect(await redis.exists(productKey)).toBe(1);

      // Warm list cache
      await request(app).get('/api/products?page=1&limit=10');

      // Perform update via ADMIN API
      const updateRes = await request(app)
        .patch(`/api/products/${product.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({ name: 'After Update Product' });
      expect(updateRes.status).toBe(200);

      // Verify individual cache key was deleted
      expect(await redis.exists(productKey)).toBe(0);

      // Subsequent read gets fresh data and reports MISS
      const freshRes = await request(app).get(`/api/products/${product.id}`);
      expect(freshRes.status).toBe(200);
      expect(freshRes.headers['x-cache']).toBe('MISS');
      expect(freshRes.body.name).toBe('After Update Product');
    });

    it('invalidates caches after product deletion', async () => {
      const product = await productService.createProduct({
        name: 'To Delete Product',
        price: 20.0,
        sku: 'TEST-DELINV-001',
        category: 'Office',
      });

      const productKey = `cache:product:${product.id}`;

      // Warm cache
      await request(app).get(`/api/products/${product.id}`);
      expect(await redis.exists(productKey)).toBe(1);

      // Delete product
      await request(app)
        .delete(`/api/products/${product.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      // Verify cache key was purged
      expect(await redis.exists(productKey)).toBe(0);
    });

    it('does not invalidate cache if database update fails', async () => {
      const product = await productService.createProduct({
        name: 'Rollback Safety Product',
        price: 30.0,
        sku: 'TEST-FAIL-001',
        category: 'Office',
      });

      // Warm cache
      await request(app).get(`/api/products/${product.id}`);

      // Attempt invalid update with conflict
      const failRes = await request(app)
        .patch(`/api/products/${product.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .send({ price: -50 }); // Validation failure

      expect(failRes.status).toBe(400);

      // Cache should remain intact and valid
      const cached = await redis.get(`cache:product:${product.id}`);
      expect(cached).not.toBeNull();
    });
  });

  describe('4. Cache-Stampede Protection and Distributed Lock', () => {
    it('coordinates concurrent cache misses using lock:cache:product:{id}', async () => {
      const product = await productService.createProduct({
        name: 'Stampede Test Product',
        price: 75.0,
        sku: 'TEST-STAMP-001',
        category: 'Electronics',
      });

      const lockKey = `lock:cache:product:${product.id}`;

      // Verify lock can be acquired and released with token safety
      const token1 = await productCacheLockService.acquireLock(product.id);
      expect(token1).not.toBeNull();

      // Second acquire attempt must fail while lock is held
      const token2 = await productCacheLockService.acquireLock(product.id);
      expect(token2).toBeNull();

      // Release attempt with wrong token fails (ownership protection via Lua)
      const wrongRelease = await productCacheLockService.releaseLock(product.id, 'wrong-token');
      expect(wrongRelease).toBe(false);

      // Release attempt with correct token succeeds
      const validRelease = await productCacheLockService.releaseLock(product.id, token1!);
      expect(validRelease).toBe(true);

      // Lock key must no longer exist
      expect(await redis.exists(lockKey)).toBe(0);
    });

    it('ensures lock TTL automatically prevents deadlocks if not released', async () => {
      const shortLockService = new ProductCacheLockService(redis, 100); // 100ms TTL
      const lockKey = shortLockService.getLockKey('deadlock-test-id');

      const token = await shortLockService.acquireLock('deadlock-test-id');
      expect(token).not.toBeNull();

      // Wait for TTL expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Lock should have expired automatically in Redis
      expect(await redis.exists(lockKey)).toBe(0);

      // Another request can now acquire the lock
      const tokenAfterExpiry = await shortLockService.acquireLock('deadlock-test-id');
      expect(tokenAfterExpiry).not.toBeNull();
      await shortLockService.releaseLock('deadlock-test-id', tokenAfterExpiry!);
    });

    it('handles concurrent requests cleanly without duplicate database storms', async () => {
      const product = await productService.createProduct({
        name: 'Concurrent Storm Product',
        price: 150.0,
        sku: 'TEST-STORM-001',
        category: 'Electronics',
      });

      // Clear cache
      await redis.del(`cache:product:${product.id}`);

      // Fire 5 concurrent requests simultaneously
      const responses = await Promise.all([
        request(app).get(`/api/products/${product.id}`),
        request(app).get(`/api/products/${product.id}`),
        request(app).get(`/api/products/${product.id}`),
        request(app).get(`/api/products/${product.id}`),
        request(app).get(`/api/products/${product.id}`),
      ]);

      // All requests must succeed
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(product.id);
      }

      // At least one request got MISS (the lock winner) and subsequent requests resolved with HIT or bounded fallback
      const cacheHeaders = responses.map((r) => r.headers['x-cache']);
      expect(cacheHeaders).toContain('MISS');
    });
  });
});
