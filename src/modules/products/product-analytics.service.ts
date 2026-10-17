import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { logger } from '../../config/logger.js';
import { ProductRepository, productRepository } from './products.repository.js';
import { TrendingService, trendingService } from './trending.service.js';
import { UniqueViewersService, uniqueViewersService } from './unique-viewers.service.js';
import type { ProductAnalyticsResponse } from './products.types.js';

export class ProductAnalyticsService {
  private readonly redis: Redis;
  private readonly repo: ProductRepository;
  private readonly trending: TrendingService;
  private readonly uniqueViewers: UniqueViewersService;

  constructor(
    redisInstance: Redis = redis,
    repo: ProductRepository = productRepository,
    trending: TrendingService = trendingService,
    uniqueViewers: UniqueViewersService = uniqueViewersService,
  ) {
    this.redis = redisInstance;
    this.repo = repo;
    this.trending = trending;
    this.uniqueViewers = uniqueViewers;
  }

  /**
   * Redis key pattern for the high-frequency product view counter.
   * Pattern: views:product:{productId}
   */
  public getViewCounterKey(productId: string): string {
    return `views:product:${productId}`;
  }

  /**
   * Redis key pattern for the set of products with unaggregated views.
   * Pattern: views:active_products (Redis Set)
   * Avoids unbounded KEYS * scans during aggregation.
   */
  public getActiveProductsKey(): string {
    return 'views:active_products';
  }

  /**
   * Records a qualifying product view across all Redis analytics structures.
   *
   * High-Frequency Counting with INCR:
   * Redis INCR atomically increments the string-based integer counter. Because Redis executes
   * in-memory with sub-millisecond latency, INCR handles massive view concurrency without
   * burdening MySQL with thousands of lock-contended write transactions.
   *
   * Analytics components updated concurrently:
   * 1. View Counter: Atomically incremented via INCR views:product:{productId}
   * 2. Active Set: Product registered in views:active_products for bounded aggregation discovery
   * 3. Trending Leaderboard: Popularity score incremented via ZINCRBY trending:products 1 {productId}
   * 4. Unique Viewers: Cardinally tracked in HyperLogLog via PFADD views:unique:product:{productId}
   *
   * @param productId Target product UUID
   * @param rawViewerIdentifier User ID or client IP + User-Agent for privacy-safe HMAC token generation
   */
  public async recordProductView(
    productId: string,
    rawViewerIdentifier: string,
  ): Promise<void> {
    const counterKey = this.getViewCounterKey(productId);
    const activeSetKey = this.getActiveProductsKey();
    const viewerToken = this.uniqueViewers.generateViewerToken(rawViewerIdentifier);

    try {
      // Execute Redis counter increment and active set registration via pipeline
      const pipeline = this.redis.pipeline();
      // INCR: Atomically increments integer counter; initializes to 0 if key does not exist
      pipeline.incr(counterKey);
      // SADD: Registers product ID in tracking set for bounded scanner discovery
      pipeline.sadd(activeSetKey, productId);

      await Promise.allSettled([
        pipeline.exec(),
        this.trending.incrementScore(productId, 1),
        this.uniqueViewers.recordUniqueView(productId, viewerToken),
      ]);
    } catch (err: unknown) {
      // Redis analytics failures must not crash the API or impact product reads
      logger.error(
        { err, productId },
        'Warning: Failed to record product view analytics in Redis',
      );
    }
  }

  /**
   * Reads the current unaggregated Redis counter value for a product.
   */
  public async getUnaggregatedViews(productId: string): Promise<number> {
    const counterKey = this.getViewCounterKey(productId);

    try {
      const val = await this.redis.get(counterKey);
      return val ? parseInt(val, 10) : 0;
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Redis error while reading unaggregated view counter');
      return 0;
    }
  }

  /**
   * Retrieves combined analytics for a product:
   * - Total views: MySQL persisted views + real-time unaggregated Redis delta.
   * - Estimated unique viewers: HyperLogLog approximate cardinality.
   * - Trending popularity score: Sorted Set real-time score.
   */
  public async getProductAnalytics(productId: string): Promise<ProductAnalyticsResponse> {
    const [persistedStat, unaggregatedViews, estimatedUniqueViewers, trendingScore] =
      await Promise.all([
        this.repo.getProductStatistic(productId),
        this.getUnaggregatedViews(productId),
        this.uniqueViewers.getEstimatedUniqueViewers(productId),
        this.trending.getScore(productId),
      ]);

    const persistedViews = persistedStat ? persistedStat.totalViews : 0;
    const totalViews = persistedViews + unaggregatedViews;

    return {
      productId,
      totalViews,
      persistedViews,
      unaggregatedViews,
      estimatedUniqueViewers,
      trendingScore,
      isEstimate: true,
    };
  }

  /**
   * Cleans up analytics keys when a product is deleted from MySQL.
   */
  public async cleanupProductAnalytics(productId: string): Promise<void> {
    const counterKey = this.getViewCounterKey(productId);
    const activeSetKey = this.getActiveProductsKey();

    try {
      const pipeline = this.redis.pipeline();
      pipeline.del(counterKey);
      pipeline.srem(activeSetKey, productId);
      await pipeline.exec();

      await Promise.allSettled([
        this.trending.removeProduct(productId),
        this.uniqueViewers.removeProduct(productId),
      ]);

      logger.info({ productId }, 'Cleaned up product analytics keys');
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Error cleaning up product analytics keys');
    }
  }
}

export const productAnalyticsService = new ProductAnalyticsService();
