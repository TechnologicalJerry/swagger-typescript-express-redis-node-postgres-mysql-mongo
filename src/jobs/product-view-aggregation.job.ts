import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../db/redis/client.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ProductRepository, productRepository } from '../modules/products/products.repository.js';
import type { AggregationBatchResult } from '../modules/products/products.types.js';

/**
 * Atomic Lua script to drain view counters into a durable pending batch.
 *
 * Atomicity Guarantee:
 * Executes atomically within Redis. Reads active product IDs from the tracking set,
 * drains each counter via GET + DEL, and writes the drained values directly into the
 * pending batch Hash. Concurrent INCR operations arriving before DEL are captured in
 * the batch; concurrent INCR operations arriving after DEL initialize a fresh counter
 * and re-register in the active products set.
 */
const DRAIN_COUNTERS_LUA = `
local activeSetKey = KEYS[1]
local pendingBatchesKey = KEYS[2]
local batchHashKey = KEYS[3]
local batchId = ARGV[1]
local batchSize = tonumber(ARGV[2])
local prefix = ARGV[3]

local productIds = redis.call('SRANDMEMBER', activeSetKey, batchSize)
if not productIds or #productIds == 0 then
  return 0
end

local drainedCount = 0

for _, productId in ipairs(productIds) do
  local counterKey = prefix .. productId
  local count = tonumber(redis.call('GET', counterKey))
  if count and count > 0 then
    redis.call('DEL', counterKey)
    redis.call('HSET', batchHashKey, productId, count)
    drainedCount = drainedCount + 1
  end
  redis.call('SREM', activeSetKey, productId)
end

if drainedCount > 0 then
  redis.call('SADD', pendingBatchesKey, batchId)
  redis.call('EXPIRE', batchHashKey, 86400)
end

return drainedCount
`;

export class ProductViewAggregationJob {
  private readonly redis: Redis;
  private readonly repo: ProductRepository;
  public readonly batchSize: number;
  public readonly activeSetKey = 'views:active_products';
  public readonly pendingBatchesKey = 'views:pending_batches';
  public readonly counterPrefix = 'views:product:';

  constructor(
    redisInstance: Redis = redis,
    repo: ProductRepository = productRepository,
    batchSize: number = env.PRODUCT_VIEW_BATCH_SIZE,
  ) {
    this.redis = redisInstance;
    this.repo = repo;
    this.batchSize = batchSize;
  }

  public getPendingBatchKey(batchId: string): string {
    return `views:pending_batch:${batchId}`;
  }

  /**
   * Recovers and persists any unacknowledged pending batches from previous failed runs.
   * Ensures zero data loss across process restarts or transient MySQL outages.
   */
  public async recoverPendingBatches(): Promise<number> {
    try {
      const batchIds = await this.redis.smembers(this.pendingBatchesKey);
      if (!batchIds || batchIds.length === 0) {
        return 0;
      }

      logger.info({ pendingCount: batchIds.length }, 'Recovering unacknowledged pending aggregation batches');
      let recoveredCount = 0;

      for (const batchId of batchIds) {
        const success = await this.processBatch(batchId);
        if (success) {
          recoveredCount++;
        }
      }

      return recoveredCount;
    } catch (err: unknown) {
      logger.error({ err }, 'Error recovering pending aggregation batches');
      return 0;
    }
  }

  /**
   * Persists a pending batch into MySQL and removes it from Redis upon success.
   * Leverages MySQL processed_aggregation_batches table for idempotent deduplication.
   */
  public async processBatch(batchId: string): Promise<boolean> {
    const batchKey = this.getPendingBatchKey(batchId);

    try {
      const rawData = await this.redis.hgetall(batchKey);
      const items: Array<{ productId: string; delta: number }> = [];

      for (const [productId, countStr] of Object.entries(rawData)) {
        const delta = parseInt(countStr, 10);
        if (!isNaN(delta) && delta > 0) {
          items.push({ productId, delta });
        }
      }

      if (items.length > 0) {
        // Persist to MySQL within a transaction
        await this.repo.persistAggregationBatch(batchId, items);
      }

      // MySQL committed successfully: Acknowledge and purge pending batch in Redis
      const pipeline = this.redis.pipeline();
      pipeline.del(batchKey);
      pipeline.srem(this.pendingBatchesKey, batchId);
      await pipeline.exec();

      return true;
    } catch (err: unknown) {
      logger.error(
        { err, batchId },
        'Failed to persist aggregation batch into MySQL; batch retained in Redis for recovery',
      );
      return false;
    }
  }

  /**
   * Executes a single aggregation cycle:
   * 1. Recovers any unacknowledged batches from previous cycles.
   * 2. Atomically drains a new batch of active counters from Redis into a pending batch.
   * 3. Persists the new batch to MySQL with idempotent batch recording.
   * 4. Acknowledges and deletes the pending batch upon MySQL success.
   */
  public async runAggregation(): Promise<AggregationBatchResult> {
    // 1. Recover unacknowledged pending batches first
    await this.recoverPendingBatches();

    const batchId = crypto.randomUUID();
    const batchKey = this.getPendingBatchKey(batchId);

    try {
      // 2. Atomically drain counters into pending batch hash via Lua
      const drainedCount = await this.redis.eval(
        DRAIN_COUNTERS_LUA,
        3,
        this.activeSetKey,
        this.pendingBatchesKey,
        batchKey,
        batchId,
        this.batchSize,
        this.counterPrefix,
      );

      if (Number(drainedCount) === 0) {
        return {
          batchId,
          itemCount: 0,
          totalViews: 0,
          status: 'SKIPPED',
        };
      }

      // 3. Read and persist drained items
      const rawData = await this.redis.hgetall(batchKey);
      const items: Array<{ productId: string; delta: number }> = [];
      let totalViews = 0;

      for (const [productId, countStr] of Object.entries(rawData)) {
        const delta = parseInt(countStr, 10);
        if (!isNaN(delta) && delta > 0) {
          items.push({ productId, delta });
          totalViews += delta;
        }
      }

      // 4. Persist to MySQL
      const persisted = await this.processBatch(batchId);

      return {
        batchId,
        itemCount: items.length,
        totalViews,
        status: persisted ? 'SUCCESS' : 'FAILED',
      };
    } catch (err: unknown) {
      logger.error({ err, batchId }, 'Error running product view aggregation cycle');
      return {
        batchId,
        itemCount: 0,
        totalViews: 0,
        status: 'FAILED',
      };
    }
  }
}

export const productViewAggregationJob = new ProductViewAggregationJob();
