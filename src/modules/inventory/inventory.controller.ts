import type { Request, Response } from 'express';
import { InventoryService, inventoryService } from './inventory.service.js';
import {
  createInventorySchema,
  adjustInventorySchema,
  decrementStockSchema,
  reserveStockSchema,
  productIdParamSchema,
} from './inventory.schema.js';

export class InventoryController {
  private readonly service: InventoryService;

  constructor(service: InventoryService = inventoryService) {
    this.service = service;
  }

  /**
   * POST /api/inventory
   * Creates an inventory record for a product in PostgreSQL.
   * Requires ADMIN authorization.
   */
  public create = async (req: Request, res: Response): Promise<void> => {
    const input = createInventorySchema.parse(req.body);
    const inventory = await this.service.createInventory(input);
    res.status(201).json(inventory);
  };

  /**
   * GET /api/inventory/:productId
   * Retrieves authoritative inventory record from PostgreSQL.
   */
  public getByProductId = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const inventory = await this.service.getInventory(params.productId);
    res.status(200).json(inventory);
  };

  /**
   * PATCH /api/inventory/:productId
   * Adjusts physical stock quantity in PostgreSQL under row-level lock.
   * Requires ADMIN authorization.
   */
  public adjust = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const body = adjustInventorySchema.parse(req.body);
    const updated = await this.service.adjustInventory(params.productId, body.quantity);
    res.status(200).json(updated);
  };

  /**
   * POST /api/inventory/:productId/decrement
   * Authoritative PostgreSQL atomic stock decrement using SELECT ... FOR UPDATE.
   */
  public decrement = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const body = decrementStockSchema.parse(req.body);
    const result = await this.service.decrementStock(params.productId, body.amount);
    res.status(200).json(result);
  };

  /**
   * POST /api/inventory/:productId/reserve-postgres
   * Authoritative PostgreSQL stock reservation using SELECT ... FOR UPDATE or pg_advisory_xact_lock.
   */
  public reservePostgres = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const body = reserveStockSchema.parse(req.body);
    const result = await this.service.reserveStockPostgres(
      params.productId,
      body.amount,
      body.useAdvisoryLock,
    );
    res.status(200).json(result);
  };

  /**
   * POST /api/inventory/:productId/reserve-redis
   * Isolated Redis atomic stock reservation demonstration using Lua script.
   */
  public reserveRedis = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const body = decrementStockSchema.parse(req.body);
    const result = await this.service.reserveStockRedis(params.productId, body.amount);
    res.status(200).json(result);
  };
}

export const inventoryController = new InventoryController();
