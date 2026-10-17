import { postgresDb } from '../../db/postgres/client.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../config/logger.js';
import type { InventoryRecord, StockOperationResult } from './inventory.types.js';

interface RawInventoryRow {
  id: string;
  product_id: string;
  quantity: number;
  reserved_quantity: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function toInventoryRecord(row: RawInventoryRow): InventoryRecord {
  const qty = Number(row.quantity);
  const reserved = Number(row.reserved_quantity);
  return {
    id: row.id,
    productId: row.product_id,
    quantity: qty,
    reservedQuantity: reserved,
    availableQuantity: qty - reserved,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresStockService {
  /**
   * Retrieves an inventory record by product ID from PostgreSQL.
   */
  public async findByProductId(productId: string): Promise<InventoryRecord | null> {
    try {
      const rows = await postgresDb.$queryRawUnsafe<RawInventoryRow[]>(
        'SELECT id, product_id, quantity, reserved_quantity, created_at, updated_at FROM inventories WHERE product_id = $1 LIMIT 1',
        productId,
      );

      if (!rows || rows.length === 0) {
        return null;
      }

      return toInventoryRecord(rows[0]);
    } catch (err: unknown) {
      logger.error({ err, productId }, 'Error querying inventory by product ID from PostgreSQL');
      throw err;
    }
  }

  /**
   * Creates an initial inventory record in PostgreSQL.
   */
  public async createInventory(productId: string, quantity: number): Promise<InventoryRecord> {
    try {
      const rows = await postgresDb.$queryRawUnsafe<RawInventoryRow[]>(
        `INSERT INTO inventories (id, product_id, quantity, reserved_quantity, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 0, NOW(), NOW())
         RETURNING id, product_id, quantity, reserved_quantity, created_at, updated_at`,
        productId,
        quantity,
      );

      return toInventoryRecord(rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('inventories_product_id_key') || message.includes('unique constraint')) {
        throw new HttpError(409, 'Inventory record already exists for this product');
      }
      logger.error({ err, productId }, 'Failed to create inventory record in PostgreSQL');
      throw err;
    }
  }

  /**
   * Adjusts the physical stock quantity in PostgreSQL under row-level lock.
   * Ensures new physical stock is not lower than currently reserved stock.
   */
  public async adjustInventory(productId: string, newQuantity: number): Promise<InventoryRecord> {
    return await postgresDb.$transaction(async (tx) => {
      // 1. Lock the inventory row using SELECT ... FOR UPDATE
      const rows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
        'SELECT id, product_id, quantity, reserved_quantity, created_at, updated_at FROM inventories WHERE product_id = $1 FOR UPDATE',
        productId,
      );

      if (!rows || rows.length === 0) {
        throw new HttpError(404, 'Inventory record not found');
      }

      const current = toInventoryRecord(rows[0]);

      if (newQuantity < current.reservedQuantity) {
        throw new HttpError(
          409,
          `Cannot adjust stock quantity to ${newQuantity}: currently reserved quantity is ${current.reservedQuantity}`,
        );
      }

      // 2. Apply quantity update
      const updatedRows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
        `UPDATE inventories
         SET quantity = $1, updated_at = NOW()
         WHERE product_id = $2
         RETURNING id, product_id, quantity, reserved_quantity, created_at, updated_at`,
        newQuantity,
        productId,
      );

      return toInventoryRecord(updatedRows[0]);
    });
  }

  /**
   * Atomically decrements physical stock using PostgreSQL transactions and SELECT ... FOR UPDATE.
   *
   * PostgreSQL Row-Level Locking:
   * SELECT ... FOR UPDATE locks the specific inventory row in PostgreSQL. Any concurrent request
   * attempting to lock or mutate the same product row is blocked until this transaction commits
   * or rolls back. This prevents race conditions and ensures stock is never oversold under high concurrency.
   *
   * @param productId Target product UUID
   * @param amount Units to decrement (must be positive)
   */
  public async decrementStock(productId: string, amount: number): Promise<StockOperationResult> {
    if (amount <= 0) {
      throw new HttpError(400, 'Decrement amount must be a positive integer');
    }

    return await postgresDb.$transaction(async (tx) => {
      // 1. Acquire row lock and read authoritative stock state
      const rows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
        'SELECT id, product_id, quantity, reserved_quantity, created_at, updated_at FROM inventories WHERE product_id = $1 FOR UPDATE',
        productId,
      );

      if (!rows || rows.length === 0) {
        throw new HttpError(404, 'Inventory record not found');
      }

      const current = toInventoryRecord(rows[0]);

      // 2. Validate available stock (physical quantity minus reserved quantity)
      if (current.availableQuantity < amount) {
        throw new HttpError(
          409,
          `Insufficient stock: requested ${amount}, available ${current.availableQuantity}`,
        );
      }

      // 3. Atomically decrement physical stock
      const updatedRows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
        `UPDATE inventories
         SET quantity = quantity - $1, updated_at = NOW()
         WHERE product_id = $2
         RETURNING id, product_id, quantity, reserved_quantity, created_at, updated_at`,
        amount,
        productId,
      );

      const updated = toInventoryRecord(updatedRows[0]);

      return {
        success: true,
        productId,
        previousAvailable: current.availableQuantity,
        newAvailable: updated.availableQuantity,
        inventory: updated,
        mode: 'POSTGRES_ROW_LOCK',
        message: `Successfully decremented ${amount} units using PostgreSQL SELECT FOR UPDATE`,
      };
    });
  }

  /**
   * Reserves stock in PostgreSQL using either row-level locking (SELECT ... FOR UPDATE)
   * or transaction-scoped advisory locking (pg_advisory_xact_lock).
   *
   * @param productId Target product UUID
   * @param amount Units to reserve
   * @param useAdvisoryLock If true, demonstrates PostgreSQL advisory locking instead of row-level lock
   */
  public async reserveStock(
    productId: string,
    amount: number,
    useAdvisoryLock: boolean = false,
  ): Promise<StockOperationResult> {
    if (amount <= 0) {
      throw new HttpError(400, 'Reservation amount must be a positive integer');
    }

    return await postgresDb.$transaction(async (tx) => {
      let rows: RawInventoryRow[];

      if (useAdvisoryLock) {
        /**
         * PostgreSQL Transaction-Level Advisory Lock:
         * pg_advisory_xact_lock(hashtext($1)) creates an application-defined mutex lock
         * in PostgreSQL shared memory rather than locking an existing row. hashtext() deterministically
         * hashes the product UUID string into a signed 32-bit integer. The lock is transaction-scoped,
         * ensuring automatic release upon COMMIT or ROLLBACK.
         */
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', productId);

        rows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
          'SELECT id, product_id, quantity, reserved_quantity, created_at, updated_at FROM inventories WHERE product_id = $1',
          productId,
        );
      } else {
        // Row-level lock via SELECT ... FOR UPDATE
        rows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
          'SELECT id, product_id, quantity, reserved_quantity, created_at, updated_at FROM inventories WHERE product_id = $1 FOR UPDATE',
          productId,
        );
      }

      if (!rows || rows.length === 0) {
        throw new HttpError(404, 'Inventory record not found');
      }

      const current = toInventoryRecord(rows[0]);

      if (current.availableQuantity < amount) {
        throw new HttpError(
          409,
          `Insufficient stock: requested ${amount}, available ${current.availableQuantity}`,
        );
      }

      // Increment reserved_quantity (physical quantity remains unchanged)
      const updatedRows = await tx.$queryRawUnsafe<RawInventoryRow[]>(
        `UPDATE inventories
         SET reserved_quantity = reserved_quantity + $1, updated_at = NOW()
         WHERE product_id = $2
         RETURNING id, product_id, quantity, reserved_quantity, created_at, updated_at`,
        amount,
        productId,
      );

      const updated = toInventoryRecord(updatedRows[0]);

      return {
        success: true,
        productId,
        previousAvailable: current.availableQuantity,
        newAvailable: updated.availableQuantity,
        inventory: updated,
        mode: useAdvisoryLock ? 'POSTGRES_ADVISORY_LOCK' : 'POSTGRES_ROW_LOCK',
        message: `Successfully reserved ${amount} units using ${
          useAdvisoryLock ? 'PostgreSQL pg_advisory_xact_lock' : 'PostgreSQL SELECT FOR UPDATE'
        }`,
      };
    });
  }
}

export const postgresStockService = new PostgresStockService();
