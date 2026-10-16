import { z } from 'zod';
import type { DefaultJobOptions } from 'bullmq';

export enum BullQueueName {
  PRODUCT_VIEW_AGGREGATION = 'product-view-aggregation',
  RESERVATION_EXPIRY = 'reservation-expiry',
  OUTBOX_DISPATCH = 'outbox-dispatch',
}

export const ProductViewAggregationJobDataSchema = z.object({
  triggeredAt: z.number().int().positive().default(() => Date.now()),
  batchSize: z.number().int().positive().default(100),
});
export type ProductViewAggregationJobData = z.infer<typeof ProductViewAggregationJobDataSchema>;

export const ReservationExpiryJobDataSchema = z.object({
  triggeredAt: z.number().int().positive().default(() => Date.now()),
  batchSize: z.number().int().positive().default(50),
});
export type ReservationExpiryJobData = z.infer<typeof ReservationExpiryJobDataSchema>;

export const OutboxDispatchJobDataSchema = z.object({
  triggeredAt: z.number().int().positive().default(() => Date.now()),
  batchSize: z.number().int().positive().default(20),
});
export type OutboxDispatchJobData = z.infer<typeof OutboxDispatchJobDataSchema>;

export const DEFAULT_BULLMQ_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: {
    count: 100,
    age: 3600,
  },
  removeOnFail: {
    count: 200,
    age: 86400,
  },
};
