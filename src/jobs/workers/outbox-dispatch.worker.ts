import { Worker, type Job } from 'bullmq';
import { getBullConnectionOptions } from '../connection.js';
import { BullQueueName, type OutboxDispatchJobData } from '../types/bullmq.types.js';
import {
  OutboxDispatchProcessor,
  outboxDispatchProcessor,
} from '../processors/outbox-dispatch.processor.js';
import { logger } from '../../config/logger.js';

export class OutboxDispatchWorker {
  private workerInstance: Worker<OutboxDispatchJobData> | null = null;
  private readonly processor: OutboxDispatchProcessor;

  constructor(processor: OutboxDispatchProcessor = outboxDispatchProcessor) {
    this.processor = processor;
  }

  public start(): Worker<OutboxDispatchJobData> {
    if (this.workerInstance) {
      return this.workerInstance;
    }

    this.workerInstance = new Worker<OutboxDispatchJobData>(
      BullQueueName.OUTBOX_DISPATCH,
      async (job: Job<OutboxDispatchJobData>) => {
        return this.processor.process(job);
      },
      {
        connection: getBullConnectionOptions(),
        concurrency: 1, // Single worker concurrency ensures sequential outbox event publishing
      },
    );

    this.workerInstance.on('completed', (job) => {
      logger.info(
        { queue: BullQueueName.OUTBOX_DISPATCH, jobId: job.id, returnValue: job.returnvalue },
        'Job completed successfully',
      );
    });

    this.workerInstance.on('failed', (job, err) => {
      logger.error(
        {
          queue: BullQueueName.OUTBOX_DISPATCH,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          err: err.message,
        },
        'Job failed',
      );
    });

    this.workerInstance.on('error', (err) => {
      logger.error({ queue: BullQueueName.OUTBOX_DISPATCH, err: err.message }, 'BullMQ Worker error');
    });

    logger.info({ queue: BullQueueName.OUTBOX_DISPATCH }, 'Outbox dispatch worker started');
    return this.workerInstance;
  }

  public async close(): Promise<void> {
    if (this.workerInstance) {
      logger.info({ queue: BullQueueName.OUTBOX_DISPATCH }, 'Stopping outbox dispatch worker');
      await this.workerInstance.close();
      this.workerInstance = null;
    }
  }

  public isRunning(): boolean {
    return this.workerInstance !== null && this.workerInstance.isRunning();
  }
}

export const outboxDispatchWorker = new OutboxDispatchWorker();
