import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class UniqueViewersService {
  private readonly redis: Redis;
  private readonly hmacSecret: string;

  constructor(
    redisInstance: Redis = redis,
    hmacSecret: string = env.VIEWER_HMAC_SECRET,
  ) {
    this.redis = redisInstance;
    this.hmacSecret = hmacSecret;
  }

  /**
   * Redis key pattern for product HyperLogLog unique-viewer tracking.
   * Pattern: views:unique:product:{productId}
   */
  public getHyperLogLogKey(productId: string): string {
    return `views:unique:product:${productId}`;
  }

  /**
   * Generates a privacy-conscious pseudonymous viewer token.
   * Uses HMAC-SHA256 with a dedicated server-side secret key to prevent storing
   * raw user IDs, emails, IP addresses, or session tokens in Redis.
   *
   * @param rawIdentifier Internal user ID (for authenticated callers) or client IP + User-Agent (for anonymous callers)
   */
  public generateViewerToken(rawIdentifier: string): string {
    return crypto
      .createHmac('sha256', this.hmacSecret)
      .update(rawIdentifier)
      .digest('hex');
  }

  /**
   * Records a product view in the product's HyperLogLog data structure.
   *
   * HyperLogLog (HLL) uses the PFADD command to register elements with a fixed,
   * compact memory footprint of ~12 KB per key, achieving an approximate cardinality
   * estimation with a standard error of ~0.81%. It does not retain individual viewer
   * identifiers, preserving caller privacy and keeping memory usage constant regardless
   * of whether there are 10 or 10,000,000 views.
   *
   * @param productId Product UUID
   * @param viewerToken Pseudonymous HMAC viewer token
   * @returns true if the estimated cardinality was modified, false if already observed
   */
  public async recordUniqueView(productId: string, viewerToken: string): Promise<boolean> {
    const key = this.getHyperLogLogKey(productId);

    try {
      // PFADD key element [element ...]
      // Returns 1 if at least 1 HyperLogLog internal register was altered, 0 otherwise.
      const result = await this.redis.pfadd(key, viewerToken);
      return result === 1;
    } catch (err: unknown) {
      logger.warn(
        { err, productId },
        'Redis error while recording unique view in HyperLogLog; continuing gracefully',
      );
      return false;
    }
  }

  /**
   * Retrieves the approximate number of distinct viewers for a product.
   *
   * Uses PFCOUNT to query the HyperLogLog estimate. HyperLogLog estimates cardinality
   * and cannot produce an exact count or list individual viewers.
   *
   * @param productId Product UUID
   * @returns Approximate count of unique viewers, or 0 if empty or upon Redis error
   */
  public async getEstimatedUniqueViewers(productId: string): Promise<number> {
    const key = this.getHyperLogLogKey(productId);

    try {
      // PFCOUNT key [key ...]
      // Returns the approximated cardinality of the HyperLogLog set.
      const count = await this.redis.pfcount(key);
      return count;
    } catch (err: unknown) {
      logger.warn(
        { err, productId },
        'Redis error while reading HyperLogLog unique viewers; returning 0',
      );
      return 0;
    }
  }

  /**
   * Removes the HyperLogLog key for a product (e.g. upon product deletion).
   */
  public async removeProduct(productId: string): Promise<void> {
    const key = this.getHyperLogLogKey(productId);
    try {
      await this.redis.del(key);
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Redis error while deleting HyperLogLog key');
    }
  }
}

export const uniqueViewersService = new UniqueViewersService();
