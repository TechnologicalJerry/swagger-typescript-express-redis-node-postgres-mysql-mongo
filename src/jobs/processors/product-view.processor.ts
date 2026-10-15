import type { Job } from 'bullmq';
import {
  type ProductViewAggregationJobData,
  ProductViewAggregationJobDataSchema,
} from '../types/bullmq.types.js';
import { ProductViewAggregationJob } from '../product-view-aggregation.job.js';
import { logger } from '../../config/logger.js';

import type { AggregationBatchResult } from '../../modules/products/products.types.js';

export class ProductViewAggregationProcessor {
  private readonly jobRunner: ProductViewAggregationJob;

  constructor(jobRunner: ProductViewAggregationJob = new ProductViewAggregationJob()) {
    this.jobRunner = jobRunner;
  }

  public async process(job: Job<ProductViewAggregationJobData>): Promise<AggregationBatchResult> {
    const validatedData = ProductViewAggregationJobDataSchema.parse(job.data);

    logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
        batchSize: validatedData.batchSize,
      },
      'Processing product view aggregation job',
    );

    try {
      const result = await this.jobRunner.runAggregation();

      logger.info(
        {
          jobId: job.id,
          batchId: result.batchId,
          itemCount: result.itemCount,
          totalViews: result.totalViews,
          status: result.status,
        },
        'Product view aggregation job completed',
      );

      return result;
    } catch (err: unknown) {
      const sanitizedMessage = err instanceof Error ? err.message : 'Unknown aggregation error';
      logger.error(
        {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          err: sanitizedMessage,
        },
        'Product view aggregation processor failed',
      );
      throw err;
    }
  }
}

export const productViewAggregationProcessor = new ProductViewAggregationProcessor();
