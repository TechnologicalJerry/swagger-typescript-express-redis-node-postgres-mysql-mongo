import { Queue, type Job } from 'bullmq';
import { getBullConnectionOptions } from '../connection.js';
import {
  BullQueueName,
  DEFAULT_BULLMQ_JOB_OPTIONS,
  type OutboxDispatchJobData,
  OutboxDispatchJobDataSchema,
} from '../types/bullmq.types.js';
import { logger } from '../../config/logger.js';

export class OutboxDispatchQueue {
  private queueInstance: Queue<OutboxDispatchJobData> | null = null;

  public getQueue(): Queue<OutboxDispatchJobData> {
    if (!this.queueInstance) {
      this.queueInstance = new Queue<OutboxDispatchJobData>(BullQueueName.OUTBOX_DISPATCH, {
        connection: getBullConnectionOptions(),
        defaultJobOptions: DEFAULT_BULLMQ_JOB_OPTIONS,
      });

      this.queueInstance.on('error', (err) => {
        logger.error({ queue: BullQueueName.OUTBOX_DISPATCH, err: err.message }, 'BullMQ Queue error');
      });
    }
    return this.queueInstance;
  }

  public async enqueueOutboxDispatch(
    data: Partial<OutboxDispatchJobData> = {},
    customJobId?: string,
  ): Promise<Job<OutboxDispatchJobData>> {
    const queue = this.getQueue();
    const validated = OutboxDispatchJobDataSchema.parse({
      triggeredAt: data.triggeredAt ?? Date.now(),
      batchSize: data.batchSize ?? 20,
    });

    const job = await queue.add('dispatch-outbox-events', validated, {
      jobId: customJobId,
    });

    logger.debug(
      { queue: BullQueueName.OUTBOX_DISPATCH, jobId: job.id, batchSize: validated.batchSize },
      'Enqueued outbox dispatch job',
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

export const outboxDispatchQueue = new OutboxDispatchQueue();
