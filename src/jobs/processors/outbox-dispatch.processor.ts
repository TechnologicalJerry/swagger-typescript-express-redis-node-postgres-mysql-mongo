import type { Job } from 'bullmq';
import {
  type OutboxDispatchJobData,
  OutboxDispatchJobDataSchema,
} from '../types/bullmq.types.js';
import { OutboxService, outboxService } from '../../modules/events/outbox/outbox.service.js';
import { logger } from '../../config/logger.js';

export class OutboxDispatchProcessor {
  private readonly outbox: OutboxService;

  constructor(outbox: OutboxService = outboxService) {
    this.outbox = outbox;
  }

  public async process(job: Job<OutboxDispatchJobData>): Promise<{ dispatched: number; failed: number }> {
    const validatedData = OutboxDispatchJobDataSchema.parse(job.data);

    logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
        batchSize: validatedData.batchSize,
      },
      'Processing outbox event dispatch job',
    );

    try {
      const result = await this.outbox.dispatchPendingEvents(validatedData.batchSize);

      logger.info(
        {
          jobId: job.id,
          dispatched: result.dispatched,
          failed: result.failed,
        },
        'Outbox event dispatch job completed',
      );

      return result;
    } catch (err: unknown) {
      const sanitizedMessage = err instanceof Error ? err.message : 'Unknown outbox dispatch error';
      logger.error(
        {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          err: sanitizedMessage,
        },
        'Outbox event dispatch processor failed',
      );
      throw err;
    }
  }
}

export const outboxDispatchProcessor = new OutboxDispatchProcessor();
