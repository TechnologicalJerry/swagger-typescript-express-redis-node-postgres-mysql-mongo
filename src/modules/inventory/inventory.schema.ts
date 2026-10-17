import { z } from 'zod';

export const createInventorySchema = z
  .object({
    productId: z.string().trim().min(1, 'Product ID is required').max(36),
    quantity: z
      .coerce
      .number()
      .int('Quantity must be an integer')
      .min(0, 'Quantity cannot be negative'),
  })
  .strict();

export const adjustInventorySchema = z
  .object({
    quantity: z
      .coerce
      .number()
      .int('Quantity must be an integer')
      .min(0, 'Quantity cannot be negative'),
  })
  .strict();

export const decrementStockSchema = z
  .object({
    amount: z
      .coerce
      .number()
      .int('Amount must be an integer')
      .positive('Amount must be greater than zero'),
  })
  .strict();

export const reserveStockSchema = z
  .object({
    amount: z
      .coerce
      .number()
      .int('Amount must be an integer')
      .positive('Amount must be greater than zero'),
    useAdvisoryLock: z.boolean().optional().default(false),
  })
  .strict();

export const productIdParamSchema = z.object({
  productId: z.string().trim().min(1, 'Product ID is required').max(36),
});

export type CreateInventoryDto = z.infer<typeof createInventorySchema>;
export type AdjustInventoryDto = z.infer<typeof adjustInventorySchema>;
export type DecrementStockDto = z.infer<typeof decrementStockSchema>;
export type ReserveStockDto = z.infer<typeof reserveStockSchema>;
