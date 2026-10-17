import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { postgresStockService, PostgresStockService } from './postgres-stock.service.js';
import type { RedisReservationResult } from './inventory.types.js';

/**
 * Atomic Lua script for Redis stock reservation.
 *
 * Atomicity Guarantee:
 * Redis executes Lua scripts sequentially on a single thread. The read of current stock,
 * the sufficiency check (currentStock >= requested), and the DECRBY decrement execute
 * as a single atomic unit. No concurrent Redis operation can intervene or cause overselling.
 */
const RESERVE_STOCK_LUA = `
local stockKey = KEYS[1]
local requested = tonumber(ARGV[1])

if not requested or requested <= 0 then
  return redis.error_reply("ERR_INVALID_AMOUNT: requested quantity must be a positive integer")
end

local exists = redis.call('EXISTS', stockKey)
if exists == 0 then
  return {0, -1, "ERR_STOCK_KEY_NOT_FOUND"}
end

local currentStock = tonumber(redis.call('GET', stockKey))
if not currentStock then
  return {0, -1, "ERR_MALFORMED_STOCK_VALUE"}
end

if currentStock < requested then
  return {0, currentStock, "ERR_INSUFFICIENT_STOCK"}
end

local remaining = redis.call('DECRBY', stockKey, requested)
return {1, remaining, "SUCCESS"}
`;

export class RedisStockService {
  private readonly redis: Redis;
  private readonly postgresStock: PostgresStockService;

  constructor(
    redisInstance: Redis = redis,
    postgresStock: PostgresStockService = postgresStockService,
  ) {
    this.redis = redisInstance;
    this.postgresStock = postgresStock;
  }

  /**
   * Redis key pattern for the isolated atomic stock reservation demonstration.
   * Pattern: stock:{productId} (Redis String integer counter)
   */
  public getStockKey(productId: string): string {
    return `stock:${productId}`;
  }

  /**
   * Reads current stock from Redis for a product.
   */
  public async getCurrentStock(productId: string): Promise<number | null> {
    const key = this.getStockKey(productId);
    try {
      const val = await this.redis.get(key);
      return val !== null ? parseInt(val, 10) : null;
    } catch (err: unknown) {
      logger.error({ err, productId }, 'Redis error while reading stock key');
      return null;
    }
  }

  /**
   * Initializes or updates the Redis stock key from PostgreSQL available stock.
   * Uses SET NX to prevent concurrent initializers from overwriting active reservation state.
   *
   * @param productId Product UUID
   * @param quantity Initial available stock quantity
   * @param force If true, overwrites existing key (e.g. For administrative reconciliation)
   */
  public async initializeStock(
    productId: string,
    quantity: number,
    force: boolean = false,
  ): Promise<{ success: boolean; stock: number }> {
    const key = this.getStockKey(productId);

    try {
      if (force) {
        await this.redis.set(key, quantity.toString());
        return { success: true, stock: quantity };
      }

      // SET key quantity NX: Only set if key does not already exist
      const res = await this.redis.set(key, quantity.toString(), 'NX');
      if (res === 'OK') {
        return { success: true, stock: quantity };
      }

      // Key already exists; return existing value without overwriting
      const existing = await this.redis.get(key);
      return { success: false, stock: existing ? parseInt(existing, 10) : quantity };
    } catch (err: unknown) {
      logger.error({ err, productId }, 'Error initializing Redis stock key');
      throw err;
    }
  }

  /**
   * Synchronizes Redis stock key from PostgreSQL available stock.
   */
  public async syncFromPostgres(productId: string, force: boolean = false): Promise<number> {
    const inventory = await this.postgresStock.findByProductId(productId);
    if (!inventory) {
      throw new HttpError(404, 'Inventory record not found in PostgreSQL');
    }

    const { stock } = await this.initializeStock(productId, inventory.availableQuantity, force);
    return stock;
  }

  /**
   * Executes atomic stock reservation in Redis using Lua script.
   *
   * @param productId Target product UUID
   * @param amount Units to reserve (positive integer)
   */
  public async reserveStock(productId: string, amount: number): Promise<RedisReservationResult> {
    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new HttpError(400, 'Requested amount must be a positive integer');
    }

    const key = this.getStockKey(productId);

    try {
      // 1. Execute Lua atomic check-and-decrement
      const result = (await this.redis.eval(RESERVE_STOCK_LUA, 1, key, amount)) as [
        number,
        number,
        string,
      ];

      const [status, remainingStock, message] = result;

      // Handle key not found: Auto-initialize from PostgreSQL if record exists
      if (status === 0 && message === 'ERR_STOCK_KEY_NOT_FOUND') {
        logger.info({ productId }, 'Redis stock key missing; auto-initializing from PostgreSQL');
        await this.syncFromPostgres(productId, false);

        // Retry reservation once following initialization
        const retryResult = (await this.redis.eval(RESERVE_STOCK_LUA, 1, key, amount)) as [
          number,
          number,
          string,
        ];

        const [retryStatus, retryRemaining, retryMessage] = retryResult;
        if (retryStatus === 1) {
          return {
            success: true,
            productId,
            requestedAmount: amount,
            remainingStock: retryRemaining,
            mode: 'REDIS_LUA',
            message: 'Stock successfully reserved via Redis Lua atomic script after initialization',
          };
        }

        if (retryMessage === 'ERR_INSUFFICIENT_STOCK') {
          throw new HttpError(
            409,
            `Insufficient stock in Redis: requested ${amount}, remaining ${retryRemaining}`,
          );
        }

        throw new HttpError(400, `Redis reservation failed: ${retryMessage}`);
      }

      if (status === 0 && message === 'ERR_INSUFFICIENT_STOCK') {
        throw new HttpError(
          409,
          `Insufficient stock in Redis: requested ${amount}, remaining ${remainingStock}`,
        );
      }

      if (status === 0) {
        throw new HttpError(400, `Redis reservation rejected: ${message}`);
      }

      return {
        success: true,
        productId,
        requestedAmount: amount,
        remainingStock,
        mode: 'REDIS_LUA',
        message: 'Stock successfully reserved via Redis Lua atomic script',
      };
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        throw err;
      }
      logger.error({ err, productId, amount }, 'Unexpected error in Redis Lua stock reservation');
      throw err;
    }
  }

  /**
   * Deletes the Redis stock key (e.g. Upon product deletion).
   */
  public async deleteStock(productId: string): Promise<void> {
    const key = this.getStockKey(productId);
    try {
      await this.redis.del(key);
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Error deleting Redis stock key');
    }
  }
}

export const redisStockService = new RedisStockService();
