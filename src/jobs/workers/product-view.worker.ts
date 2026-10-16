import { Worker, type Job } from 'bullmq';
import { getBullConnectionOptions } from '../connection.js';
import { BullQueueName, type ProductViewAggregationJobData } from '../types/bullmq.types.js';
import {
  ProductViewAggregationProcessor,
  productViewAggregationProcessor,
} from '../processors/product-view.processor.js';
import { logger } from '../../config/logger.js';

export class ProductViewWorker {
  private workerInstance: Worker<ProductViewAggregationJobData> | null = null;
  private readonly processor: ProductViewAggregationProcessor;

  constructor(processor: ProductViewAggregationProcessor = productViewAggregationProcessor) {
    this.processor = processor;
  }

  public start(): Worker<ProductViewAggregationJobData> {
    if (this.workerInstance) {
      return this.workerInstance;
    }

    this.workerInstance = new Worker<ProductViewAggregationJobData>(
      BullQueueName.PRODUCT_VIEW_AGGREGATION,
      async (job: Job<ProductViewAggregationJobData>) => {
        return this.processor.process(job);
      },
      {
        connection: getBullConnectionOptions(),
        concurrency: 1, // Single worker concurrency ensures sequential batch processing without lock contention
      },
    );

    this.workerInstance.on('completed', (job) => {
      logger.info(
        { queue: BullQueueName.PRODUCT_VIEW_AGGREGATION, jobId: job.id, returnValue: job.returnvalue },
        'Job completed successfully',
      );
    });

    this.workerInstance.on('failed', (job, err) => {
      logger.error(
        {
          queue: BullQueueName.PRODUCT_VIEW_AGGREGATION,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          err: err.message,
        },
        'Job failed',
      );
    });

    this.workerInstance.on('error', (err) => {
      logger.error({ queue: BullQueueName.PRODUCT_VIEW_AGGREGATION, err: err.message }, 'BullMQ Worker error');
    });

    logger.info({ queue: BullQueueName.PRODUCT_VIEW_AGGREGATION }, 'Product view aggregation worker started');
    return this.workerInstance;
  }

  public async close(): Promise<void> {
    if (this.workerInstance) {
      logger.info({ queue: BullQueueName.PRODUCT_VIEW_AGGREGATION }, 'Stopping product view aggregation worker');
      await this.workerInstance.close();
      this.workerInstance = null;
    }
  }

  public isRunning(): boolean {
    return this.workerInstance !== null && this.workerInstance.isRunning();
  }
}

export const productViewWorker = new ProductViewWorker();
