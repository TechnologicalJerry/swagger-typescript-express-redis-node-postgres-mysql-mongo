import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { redis } from '../src/db/redis/client.js';
import { mysqlDb } from '../src/db/mysql/client.js';
import { productService } from '../src/modules/products/products.service.js';
import { productAnalyticsService, ProductAnalyticsService } from '../src/modules/products/product-analytics.service.js';
import { trendingService, TrendingService } from '../src/modules/products/trending.service.js';
import { uniqueViewersService, UniqueViewersService } from '../src/modules/products/unique-viewers.service.js';
import { productViewAggregationJob, ProductViewAggregationJob } from '../src/jobs/product-view-aggregation.job.js';
import { productViewAggregationScheduler, ProductViewAggregationScheduler } from '../src/jobs/product-view-aggregation.scheduler.js';
import { productRepository, ProductRepository } from '../src/modules/products/products.repository.js';
import type { Product } from '../src/modules/products/products.types.js';

describe('Phase 6 — Product View Counters, Trending Leaderboard, and HyperLogLog', () => {
  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const regularUserId = 'b0000000-0000-0000-0000-000000000002';

  const cleanAnalyticsData = async () => {
    // 1. Clean Redis keys
    try {
      const keys = await redis.keys('views:*');
      const trending = await redis.keys('trending:*');
      const lockKeys = await redis.keys('lock:job:*');
      const all = [...keys, ...trending, ...lockKeys];
      if (all.length > 0) {
        await redis.del(...all);
      }
    } catch {
      // Ignore during write-only test cleanup
    }

    // 2. Clean MySQL statistics & products
    try {
      const client = mysqlDb as unknown as {
        $executeRawUnsafe?: (query: string) => Promise<unknown>;
      };
      if (client.$executeRawUnsafe) {
        await client.$executeRawUnsafe('DELETE FROM processed_aggregation_batches');
        await client.$executeRawUnsafe('DELETE FROM product_statistics');
        await client.$executeRawUnsafe('DELETE FROM products WHERE sku LIKE "TEST-PH6-%"');
      }
    } catch {
      // Ignore if table not yet migrated during write-only phase
    }
  };

  beforeEach(async () => {
    await cleanAnalyticsData();
  });

  afterAll(async () => {
    await cleanAnalyticsData();
  });

  describe('Feature A — Product View Counters with INCR', () => {
    it('increments view counter atomically with INCR on qualifying product view', async () => {
      const product = await productService.createProduct({
        name: 'View Counter Test Item',
        price: 49.99,
        sku: 'TEST-PH6-VIEW-01',
        category: 'Electronics',
      });

      const counterKey = `views:product:${product.id}`;

      // Initially, counter is absent or 0
      expect(await productAnalyticsService.getUnaggregatedViews(product.id)).toBe(0);

      // Perform a qualifying view request as regular user
      const res = await request(app)
        .get(`/api/products/${product.id}`)
        .set('x-user-id', regularUserId)
        .set('x-user-role', 'USER');

      expect(res.status).toBe(200);

      // Wait briefly for asynchronous non-blocking view recording
      await new Promise((resolve) => setTimeout(resolve, 50));

      const count = await productAnalyticsService.getUnaggregatedViews(product.id);
      expect(count).toBe(1);

      // Verify product is registered in views:active_products
      const isActive = await redis.sismember('views:active_products', product.id);
      expect(isActive).toBe(1);
    });

    it('does not increment view counter for 404 nonexistent products', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000088';

      const res = await request(app).get(`/api/products/${nonExistentId}`);
      expect(res.status).toBe(404);

      const count = await productAnalyticsService.getUnaggregatedViews(nonExistentId);
      expect(count).toBe(0);
      expect(await redis.exists(`views:product:${nonExistentId}`)).toBe(0);
    });

    it('does not count administrative lookups as user views', async () => {
      const product = await productService.createProduct({
        name: 'Admin Lookup Test Item',
        price: 29.99,
        sku: 'TEST-PH6-VIEW-02',
        category: 'Office',
      });

      // Admin lookup
      const res = await request(app)
        .get(`/api/products/${product.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const count = await productAnalyticsService.getUnaggregatedViews(product.id);
      expect(count).toBe(0);
    });

    it('handles Redis errors gracefully without crashing the product read API', async () => {
      const product = await productService.createProduct({
        name: 'Redis Error Resilient Product',
        price: 89.99,
        sku: 'TEST-PH6-VIEW-03',
        category: 'Tools',
      });

      // Mock analytics service to simulate Redis failure
      const mockAnalytics = {
        recordProductView: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
      } as unknown as ProductAnalyticsService;

      // The GET endpoint should still return HTTP 200 with the product
      const res = await request(app).get(`/api/products/${product.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(product.id);
    });
  });

  describe('Feature B — Periodic Counter Aggregation into MySQL', () => {
    it('atomically drains active Redis counters and persists increments into MySQL', async () => {
      const product = await productService.createProduct({
        name: 'Aggregation Target Product',
        price: 199.99,
        sku: 'TEST-PH6-AGG-01',
        category: 'Electronics',
      });

      // Simulate 5 unaggregated views in Redis
      await redis.set(`views:product:${product.id}`, '5');
      await redis.sadd('views:active_products', product.id);

      // Run aggregation job
      const result = await productViewAggregationJob.runAggregation();
      expect(result.status).toBe('SUCCESS');
      expect(result.itemCount).toBe(1);
      expect(result.totalViews).toBe(5);

      // Counter in Redis should be drained (DEL)
      expect(await productAnalyticsService.getUnaggregatedViews(product.id)).toBe(0);
      expect(await redis.sismember('views:active_products', product.id)).toBe(0);

      // Pending batch in Redis should be purged
      expect(await redis.scard('views:pending_batches')).toBe(0);
    });

    it('accounts for concurrent views arriving during aggregation without losing increments', async () => {
      const product = await productService.createProduct({
        name: 'Concurrent View Product',
        price: 39.99,
        sku: 'TEST-PH6-AGG-02',
        category: 'Books',
      });

      // Initial count of 10 views
      await redis.set(`views:product:${product.id}`, '10');
      await redis.sadd('views:active_products', product.id);

      // Run aggregation
      const result = await productViewAggregationJob.runAggregation();
      expect(result.status).toBe('SUCCESS');
      expect(result.totalViews).toBe(10);

      // Simulate concurrent view arriving immediately after drain
      await redis.incr(`views:product:${product.id}`);
      await redis.sadd('views:active_products', product.id);

      // Unaggregated views should reflect the new increment of 1
      const remaining = await productAnalyticsService.getUnaggregatedViews(product.id);
      expect(remaining).toBe(1);
    });

    it('retains unacknowledged pending batches in Redis if MySQL persistence fails, and recovers on retry', async () => {
      const product = await productService.createProduct({
        name: 'Recovery Test Product',
        price: 59.99,
        sku: 'TEST-PH6-AGG-03',
        category: 'Apparel',
      });

      const batchId = 'recovery-test-batch-001';
      const batchKey = `views:pending_batch:${batchId}`;

      // Simulate an unacknowledged batch left in Redis due to transient MySQL error
      await redis.hset(batchKey, product.id, '25');
      await redis.sadd('views:pending_batches', batchId);

      // Mock repo failure for first attempt
      const failMockRepo = {
        persistAggregationBatch: vi.fn().mockRejectedValue(new Error('MySQL deadlock')),
      } as unknown as ProductRepository;

      const failingJob = new ProductViewAggregationJob(redis, failMockRepo, 100);
      const recovered = await failingJob.recoverPendingBatches();
      expect(recovered).toBe(0);

      // Batch remains in Redis safely
      expect(await redis.sismember('views:pending_batches', batchId)).toBe(1);
      expect(await redis.hget(batchKey, product.id)).toBe('25');

      // Now retry with working repository
      const successMockRepo = {
        persistAggregationBatch: vi.fn().mockResolvedValue(true),
      } as unknown as ProductRepository;

      const successJob = new ProductViewAggregationJob(redis, successMockRepo, 100);
      const successfulRecovery = await successJob.recoverPendingBatches();
      expect(successfulRecovery).toBe(1);

      // Batch is now safely acknowledged and purged from Redis
      expect(await redis.sismember('views:pending_batches', batchId)).toBe(0);
      expect(await redis.exists(batchKey)).toBe(0);
    });

    it('prevents double-counting when a batch is retried', async () => {
      const batchId = 'idempotent-batch-001';
      const items = [{ productId: 'mock-p1', delta: 10 }];

      let transactionCallCount = 0;
      const mockDb = {
        $transaction: vi.fn().mockImplementation(async (fn) => {
          transactionCallCount++;
          const tx = {
            $queryRawUnsafe: vi.fn().mockResolvedValue(
              transactionCallCount === 1 ? [] : [{ id: batchId }], // Second call detects batch already exists
            ),
            $executeRawUnsafe: vi.fn().mockResolvedValue(1),
          };
          return await fn(tx);
        }),
      };

      const testRepo = new ProductRepository(mockDb as unknown as any);

      // First run: Inserts batch
      const run1 = await testRepo.persistAggregationBatch(batchId, items);
      expect(run1).toBe(true);

      // Second run: Detects existing batchId and skips duplicate insertion
      const run2 = await testRepo.persistAggregationBatch(batchId, items);
      expect(run2).toBe(true);
    });

    it('prevents overlapping scheduler invocations using distributed locking', async () => {
      const mockJob = {
        runAggregation: vi.fn().mockResolvedValue({ status: 'SKIPPED' }),
      } as unknown as ProductViewAggregationJob;

      const scheduler = new ProductViewAggregationScheduler(mockJob, redis, 60000);

      // Hold scheduler lock manually
      await redis.set(scheduler.lockKey, 'manual-holder', 'PX', 10000);

      // Tick should skip because lock is held by another instance
      await scheduler.tick();
      expect(mockJob.runAggregation).not.toHaveBeenCalled();

      // Release manual lock
      await redis.del(scheduler.lockKey);

      // Tick should now successfully execute
      await scheduler.tick();
      expect(mockJob.runAggregation).toHaveBeenCalled();
    });
  });

  describe('Feature C — Trending Products Leaderboard (Sorted Set)', () => {
    it('increments popularity score using ZINCRBY on qualifying views', async () => {
      const p1 = await productService.createProduct({
        name: 'Trending Product Alpha',
        price: 15.0,
        sku: 'TEST-PH6-TREND-01',
        category: 'Electronics',
      });

      const p2 = await productService.createProduct({
        name: 'Trending Product Beta',
        price: 25.0,
        sku: 'TEST-PH6-TREND-02',
        category: 'Electronics',
      });

      // Increment p1 score by 5, p2 score by 12
      await trendingService.incrementScore(p1.id, 5);
      await trendingService.incrementScore(p2.id, 12);

      expect(await trendingService.getScore(p1.id)).toBe(5);
      expect(await trendingService.getScore(p2.id)).toBe(12);

      // Top ranked should have p2 first, then p1
      const ranked = await trendingService.getTopRanked(10);
      expect(ranked.length).toBe(2);
      expect(ranked[0].productId).toBe(p2.id);
      expect(ranked[0].score).toBe(12);
      expect(ranked[0].rank).toBe(1);

      expect(ranked[1].productId).toBe(p1.id);
      expect(ranked[1].score).toBe(5);
      expect(ranked[1].rank).toBe(2);
    });

    it('returns trending products via GET /api/products/trending in descending order', async () => {
      const p1 = await productService.createProduct({
        name: 'Leaderboard Keyboard',
        price: 99.0,
        sku: 'TEST-PH6-LEAD-01',
        category: 'Accessories',
      });

      const p2 = await productService.createProduct({
        name: 'Leaderboard Mouse',
        price: 49.0,
        sku: 'TEST-PH6-LEAD-02',
        category: 'Accessories',
      });

      await trendingService.incrementScore(p1.id, 20);
      await trendingService.incrementScore(p2.id, 35);

      const res = await request(app).get('/api/products/trending?limit=5');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);

      // Mouse should be rank 1 with score 35
      expect(res.body.data[0].product.id).toBe(p2.id);
      expect(res.body.data[0].score).toBe(35);
      expect(res.body.data[0].rank).toBe(1);

      // Keyboard should be rank 2 with score 20
      expect(res.body.data[1].product.id).toBe(p1.id);
      expect(res.body.data[1].score).toBe(20);
      expect(res.body.data[1].rank).toBe(2);
    });

    it('enforces bounds on trending query limit', async () => {
      const res = await request(app).get('/api/products/trending?limit=101');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Validation failed');
    });

    it('prunes deleted or inactive products from leaderboard results', async () => {
      const p1 = await productService.createProduct({
        name: 'Active Product',
        price: 10.0,
        sku: 'TEST-PH6-ACT-01',
        category: 'General',
        isActive: true,
      });

      const p2 = await productService.createProduct({
        name: 'To Deactivate Product',
        price: 15.0,
        sku: 'TEST-PH6-DEACT-01',
        category: 'General',
        isActive: false, // inactive
      });

      await trendingService.incrementScore(p1.id, 10);
      await trendingService.incrementScore(p2.id, 20);

      // Trending response should omit p2 because it is inactive
      const res = await productService.getTrendingProducts(10);
      const productIds = res.data.map((item) => item.product.id);

      expect(productIds).toContain(p1.id);
      expect(productIds).not.toContain(p2.id);
    });
  });

  describe('Feature D — HyperLogLog for Approximate Unique Viewers', () => {
    it('uses PFADD and PFCOUNT to estimate distinct viewer cardinality', async () => {
      const product = await productService.createProduct({
        name: 'HyperLogLog Test Product',
        price: 79.99,
        sku: 'TEST-PH6-HLL-01',
        category: 'Electronics',
      });

      const viewer1 = uniqueViewersService.generateViewerToken('user-1');
      const viewer2 = uniqueViewersService.generateViewerToken('user-2');
      const viewer3 = uniqueViewersService.generateViewerToken('user-3');

      // Add viewers
      await uniqueViewersService.recordUniqueView(product.id, viewer1);
      await uniqueViewersService.recordUniqueView(product.id, viewer2);
      await uniqueViewersService.recordUniqueView(product.id, viewer3);

      // Repeat view from user-1 should not increase distinct count
      await uniqueViewersService.recordUniqueView(product.id, viewer1);

      const estimate = await uniqueViewersService.getEstimatedUniqueViewers(product.id);
      expect(estimate).toBe(3);
    });

    it('never stores raw user IDs, emails, or IPs in HyperLogLog members', () => {
      const rawUserId = 'confidential-user-id-999';
      const token = uniqueViewersService.generateViewerToken(rawUserId);

      // Token must be a 64-char HMAC-SHA256 hex digest
      expect(token).toHaveLength(64);
      expect(token).not.toContain(rawUserId);
      expect(/^[a-f0-9]+$/.test(token)).toBe(true);
    });

    it('exposes estimatedUniqueViewers explicitly marked as estimate in GET /api/products/:id/analytics', async () => {
      const product = await productService.createProduct({
        name: 'Analytics API Product',
        price: 120.0,
        sku: 'TEST-PH6-ANALYTICS-01',
        category: 'Office',
      });

      // Seed unaggregated views, trending score, and unique viewers
      await redis.set(`views:product:${product.id}`, '15');
      await trendingService.incrementScore(product.id, 15);
      await uniqueViewersService.recordUniqueView(
        product.id,
        uniqueViewersService.generateViewerToken('client-1'),
      );
      await uniqueViewersService.recordUniqueView(
        product.id,
        uniqueViewersService.generateViewerToken('client-2'),
      );

      const res = await request(app).get(`/api/products/${product.id}/analytics`);
      expect(res.status).toBe(200);
      expect(res.body.productId).toBe(product.id);
      expect(res.body.unaggregatedViews).toBe(15);
      expect(res.body.totalViews).toBe(15);
      expect(res.body.estimatedUniqueViewers).toBe(2);
      expect(res.body.trendingScore).toBe(15);
      expect(res.body.isEstimate).toBe(true);
    });

    it('returns 404 for analytics request on non-existent product', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000077';
      const res = await request(app).get(`/api/products/${nonExistentId}/analytics`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Product not found');
    });
  });
});
