import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { logger } from '../../config/logger.js';

export interface TrendingRankItem {
  productId: string;
  score: number;
  rank: number;
}

export class TrendingService {
  private readonly redis: Redis;
  public readonly leaderboardKey: string;

  constructor(
    redisInstance: Redis = redis,
    leaderboardKey: string = 'trending:products',
  ) {
    this.redis = redisInstance;
    this.leaderboardKey = leaderboardKey;
  }

  /**
   * Increments the trending popularity score for a product.
   *
   * Redis Sorted Sets maintain a map of unique members to floating-point scores.
   * ZINCRBY atomically increments the member's score in O(log N) time and automatically
   * repositions the member within the sorted set, enabling real-time ranking without
   * database table scans or expensive application-side sorting.
   *
   * @param productId Target product UUID
   * @param increment Score increment (default 1 per qualifying view)
   * @returns Updated popularity score
   */
  public async incrementScore(productId: string, increment: number = 1): Promise<number> {
    try {
      // ZINCRBY key increment member
      // Returns the new score of member as a string
      const newScore = await this.redis.zincrby(this.leaderboardKey, increment, productId);
      return Number(newScore);
    } catch (err: unknown) {
      logger.warn(
        { err, productId },
        'Redis error while incrementing trending leaderboard score; continuing gracefully',
      );
      return 0;
    }
  }

  /**
   * Retrieves the current trending popularity score for a specific product.
   *
   * @param productId Target product UUID
   * @returns Product score, or 0 if unranked or upon Redis error
   */
  public async getScore(productId: string): Promise<number> {
    try {
      // ZSCORE key member
      // Returns the score of member, or null if member does not exist in the set
      const score = await this.redis.zscore(this.leaderboardKey, productId);
      return score ? Number(score) : 0;
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Redis error while reading trending score');
      return 0;
    }
  }

  /**
   * Retrieves the top trending products in descending order of popularity.
   *
   * Uses ZREVRANGE to query highest-scoring members first, with scores.
   *
   * @param limit Maximum number of products to return (bounded)
   * @returns Array of ranked items with 1-based rank and score
   */
  public async getTopRanked(limit: number = 10): Promise<TrendingRankItem[]> {
    if (limit <= 0) {
      return [];
    }

    try {
      // ZREVRANGE key start stop [WITHSCORES]
      // Returns members ordered from highest to lowest score
      const raw = await this.redis.zrevrange(
        this.leaderboardKey,
        0,
        limit - 1,
        'WITHSCORES',
      );

      const items: TrendingRankItem[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const productId = raw[i];
        const score = Number(raw[i + 1]);
        const rank = Math.floor(i / 2) + 1;
        items.push({ productId, score, rank });
      }

      return items;
    } catch (err: unknown) {
      logger.error({ err }, 'Redis error while fetching trending leaderboard');
      return [];
    }
  }

  /**
   * Removes a product from the trending leaderboard (e.g. Upon deletion or deactivation).
   *
   * @param productId Product UUID
   */
  public async removeProduct(productId: string): Promise<void> {
    try {
      // ZREM key member [member ...]
      // Removes member from sorted set
      await this.redis.zrem(this.leaderboardKey, productId);
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Redis error while removing product from trending leaderboard');
    }
  }
}

export const trendingService = new TrendingService();
