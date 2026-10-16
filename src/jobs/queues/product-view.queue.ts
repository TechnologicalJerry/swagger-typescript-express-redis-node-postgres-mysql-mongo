import { Queue, type Job } from 'bullmq';
import { getBullConnectionOptions } from '../connection.js';
import {
  BullQueueName,
  DEFAULT_BULLMQ_JOB_OPTIONS,
  type ProductViewAggregationJobData,
  ProductViewAggregationJobDataSchema,
} from '../types/bullmq.types.js';
import { logger } from '../../config/logger.js';

export class ProductViewQueue {
  private queueInstance: Queue<ProductViewAggregationJobData> | null = null;

  public getQueue(): Queue<ProductViewAggregationJobData> {
    if (!this.queueInstance) {
      this.queueInstance = new Queue<ProductViewAggregationJobData>(BullQueueName.PRODUCT_VIEW_AGGREGATION, {
        connection: getBullConnectionOptions(),
        defaultJobOptions: DEFAULT_BULLMQ_JOB_OPTIONS,
      });

      this.queueInstance.on('error', (err) => {
        logger.error({ queue: BullQueueName.PRODUCT_VIEW_AGGREGATION, err: err.message }, 'BullMQ Queue error');
      });
    }
    return this.queueInstance;
  }

  public async enqueueAggregation(
    data: Partial<ProductViewAggregationJobData> = {},
    customJobId?: string,
  ): Promise<Job<ProductViewAggregationJobData>> {
    const queue = this.getQueue();
    const validated = ProductViewAggregationJobDataSchema.parse({
      triggeredAt: data.triggeredAt ?? Date.now(),
      batchSize: data.batchSize ?? 100,
    });

    const job = await queue.add('aggregate-views', validated, {
      jobId: customJobId,
    });

    logger.debug(
      { queue: BullQueueName.PRODUCT_VIEW_AGGREGATION, jobId: job.id, batchSize: validated.batchSize },
      'Enqueued product view aggregation job',
    );

    return job;
  }

  public async close(): Promise<void> {
    if (this.queueInstance) {
      await this.queueInstance.close();
      this.queueInstance = null;
    }
  }
}

export const productViewQueue = new ProductViewQueue();
