import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { Product, PaginatedProductsResult, ProductQueryFilters } from './products.types.js';

export class ProductCacheService {
  private readonly redis: Redis;
  public readonly productTtlSeconds: number;
  public readonly listTtlSeconds: number;

  constructor(
    redisInstance: Redis = redis,
    productTtlSeconds: number = env.PRODUCT_CACHE_TTL_SECONDS,
    listTtlSeconds: number = env.PRODUCT_LIST_CACHE_TTL_SECONDS,
  ) {
    this.redis = redisInstance;
    this.productTtlSeconds = productTtlSeconds;
    this.listTtlSeconds = listTtlSeconds;
  }

  /**
   * Checks whether the underlying Redis connection is active and ready.
   */
  public isAvailable(): boolean {
    return this.redis.status === 'ready' || this.redis.status === 'connect';
  }

  /**
   * Redis key pattern for individual product cache entry.
   * Pattern: cache:product:{productId}
   */
  public getProductKey(productId: string): string {
    return `cache:product:${productId}`;
  }

  /**
   * Redis key pattern for tracking active product list cache keys.
   * Pattern: cache:product:list_keys (Redis Set)
   */
  public getListKeysIndex(): string {
    return 'cache:product:list_keys';
  }

  /**
   * Computes a deterministic hash fingerprint for product query filters and pagination.
   */
  public getQueryFingerprint(filters: ProductQueryFilters): string {
    const normalized = {
      page: filters.page || 1,
      limit: filters.limit || 10,
      category: filters.category ? filters.category.trim().toLowerCase() : null,
      isActive: filters.isActive !== undefined ? filters.isActive : null,
      search: filters.search ? filters.search.trim().toLowerCase() : null,
    };

    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
  }

  public getListKey(fingerprint: string): string {
    return `cache:product:list:${fingerprint}`;
  }

  /**
   * Retrieves an individual cached product from Redis.
   * Gracefully handles malformed JSON by treating it as a cache miss and purging the corrupted key.
   */
  public async getProduct(productId: string): Promise<Product | null> {
    const key = this.getProductKey(productId);

    try {
      // GET key returns the serialized JSON string or null if not found
      const data = await this.redis.get(key);
      if (!data) {
        return null;
      }

      try {
        return JSON.parse(data) as Product;
      } catch (parseErr) {
        logger.error({ parseErr, productId, key }, 'Malformed JSON encountered in product cache; purging key');
        await this.redis.del(key);
        return null;
      }
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Redis error while reading product cache; falling back to database');
      return null;
    }
  }

  /**
   * Persists an individual product to Redis with the configured TTL.
   */
  public async setProduct(product: Product): Promise<void> {
    const key = this.getProductKey(product.id);
    const serialized = JSON.stringify(product);

    try {
      // SET key serialized EX ttlSeconds
      // Caches the JSON string with automatic expiration
      await this.redis.set(key, serialized, 'EX', this.productTtlSeconds);
    } catch (err: unknown) {
      logger.error({ err, productId: product.id }, 'Failed to cache product in Redis');
    }
  }

  /**
   * Retrieves a cached paginated product list from Redis.
   */
  public async getList(fingerprint: string): Promise<PaginatedProductsResult | null> {
    const key = this.getListKey(fingerprint);

    try {
      const data = await this.redis.get(key);
      if (!data) {
        return null;
      }

      try {
        return JSON.parse(data) as PaginatedProductsResult;
      } catch (parseErr) {
        logger.error({ parseErr, fingerprint }, 'Malformed JSON encountered in product list cache; purging key');
        await this.redis.del(key);
        return null;
      }
    } catch (err: unknown) {
      logger.warn({ err, fingerprint }, 'Redis error reading product list cache');
      return null;
    }
  }

  /**
   * Persists a paginated product list to Redis and registers the key in the list index.
   */
  public async setList(fingerprint: string, result: PaginatedProductsResult): Promise<void> {
    const listKey = this.getListKey(fingerprint);
    const indexKey = this.getListKeysIndex();
    const serialized = JSON.stringify(result);

    try {
      const pipeline = this.redis.pipeline();
      // Store list cache entry with shorter TTL
      pipeline.set(listKey, serialized, 'EX', this.listTtlSeconds);
      // SADD: Register key in the tracking Set to avoid unbounded KEYS * scans on invalidation
      pipeline.sadd(indexKey, listKey);
      // Maintain index TTL so it does not linger indefinitely if no writes occur
      pipeline.expire(indexKey, this.listTtlSeconds * 2);
      await pipeline.exec();
    } catch (err: unknown) {
      logger.error({ err, fingerprint }, 'Failed to cache product list in Redis');
    }
  }

  /**
   * Invalidates all cached product lists without scanning keyspace.
   */
  public async invalidateAllLists(): Promise<void> {
    const indexKey = this.getListKeysIndex();

    try {
      // SMEMBERS: Retrieve all tracked list cache keys
      const listKeys = await this.redis.smembers(indexKey);
      if (listKeys.length > 0) {
        const pipeline = this.redis.pipeline();
        pipeline.del(...listKeys);
        pipeline.del(indexKey);
        await pipeline.exec();
        logger.info({ count: listKeys.length }, 'Invalidated cached product lists');
      }
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to invalidate product list caches in Redis');
      throw err;
    }
  }

  /**
   * Invalidates an individual product cache key and all cached lists after a mutation.
   */
  public async invalidateProduct(productId: string): Promise<void> {
    const productKey = this.getProductKey(productId);

    try {
      const pipeline = this.redis.pipeline();
      pipeline.del(productKey);
      await pipeline.exec();

      await this.invalidateAllLists();
      logger.info({ productId }, 'Product cache successfully invalidated');
    } catch (err: unknown) {
      logger.error({ err, productId }, 'Failed to invalidate product cache in Redis');
      // Report invalidation failure so caller can document/log consistency limitations
      throw err;
    }
  }
}

export const productCacheService = new ProductCacheService();
