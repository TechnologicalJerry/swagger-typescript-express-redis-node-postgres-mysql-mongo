import { PostgresStockService, postgresStockService } from './postgres-stock.service.js';
import { RedisStockService, redisStockService } from './redis-stock.service.js';
import { ProductRepository, productRepository } from '../products/products.repository.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../config/logger.js';
import type {
  InventoryRecord,
  CreateInventoryInput,
  StockOperationResult,
  RedisReservationResult,
} from './inventory.types.js';

export class InventoryService {
  private readonly postgresStock: PostgresStockService;
  private readonly redisStock: RedisStockService;
  private readonly productRepo: ProductRepository;

  constructor(
    postgresStock: PostgresStockService = postgresStockService,
    redisStock: RedisStockService = redisStockService,
    productRepo: ProductRepository = productRepository,
  ) {
    this.postgresStock = postgresStock;
    this.redisStock = redisStock;
    this.productRepo = productRepo;
  }

  /**
   * Creates an inventory record for a product.
   * Cross-database validation: Validates product existence in MySQL before persisting inventory in PostgreSQL.
   */
  public async createInventory(input: CreateInventoryInput): Promise<InventoryRecord> {
    // 1. Confirm product exists in MySQL authoritative product catalog
    const product = await this.productRepo.findById(input.productId);
    if (!product) {
      throw new HttpError(404, 'Referenced product not found in product catalog');
    }

    // 2. Persist inventory in PostgreSQL
    const inventory = await this.postgresStock.createInventory(input.productId, input.quantity);

    // 3. Initialize Redis stock key (NX safeguard prevents overwriting existing state)
    try {
      await this.redisStock.initializeStock(input.productId, inventory.availableQuantity, false);
    } catch (err: unknown) {
      logger.warn({ err, productId: input.productId }, 'Warning: Failed to initialize Redis stock key on creation');
    }

    return inventory;
  }

  /**
   * Retrieves authoritative inventory state from PostgreSQL.
   */
  public async getInventory(productId: string): Promise<InventoryRecord> {
    const inventory = await this.postgresStock.findByProductId(productId);
    if (!inventory) {
      throw new HttpError(404, 'Inventory record not found');
    }
    return inventory;
  }

  /**
   * Adjusts physical stock quantity in PostgreSQL under row-level lock.
   */
  public async adjustInventory(productId: string, quantity: number): Promise<InventoryRecord> {
    const updated = await this.postgresStock.adjustInventory(productId, quantity);

    // Reconcile Redis stock key with updated available quantity
    try {
      await this.redisStock.initializeStock(productId, updated.availableQuantity, true);
    } catch (err: unknown) {
      logger.warn({ err, productId }, 'Warning: Failed to update Redis stock key after inventory adjustment');
    }

    return updated;
  }

  /**
   * Authoritative PostgreSQL atomic stock decrement using SELECT ... FOR UPDATE.
   */
  public async decrementStock(productId: string, amount: number): Promise<StockOperationResult> {
    return await this.postgresStock.decrementStock(productId, amount);
  }

  /**
   * Authoritative PostgreSQL stock reservation using SELECT ... FOR UPDATE or pg_advisory_xact_lock.
   */
  public async reserveStockPostgres(
    productId: string,
    amount: number,
    useAdvisoryLock?: boolean,
  ): Promise<StockOperationResult> {
    return await this.postgresStock.reserveStock(productId, amount, useAdvisoryLock);
  }

  /**
   * Isolated Redis atomic stock reservation demonstration using Lua script.
   */
  public async reserveStockRedis(productId: string, amount: number): Promise<RedisReservationResult> {
    return await this.redisStock.reserveStock(productId, amount);
  }
}

export const inventoryService = new InventoryService();
