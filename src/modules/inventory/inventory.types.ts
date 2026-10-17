export interface InventoryRecord {
  id: string;
  productId: string;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInventoryInput {
  productId: string;
  quantity: number;
}

export interface AdjustStockInput {
  quantity: number;
}

export interface StockOperationInput {
  amount: number;
  useAdvisoryLock?: boolean;
}

export interface StockOperationResult {
  success: boolean;
  productId: string;
  previousAvailable: number;
  newAvailable: number;
  inventory?: InventoryRecord;
  mode: 'POSTGRES_ROW_LOCK' | 'POSTGRES_ADVISORY_LOCK';
  message?: string;
}

export interface RedisReservationResult {
  success: boolean;
  productId: string;
  requestedAmount: number;
  remainingStock: number;
  mode: 'REDIS_LUA';
  message?: string;
}
