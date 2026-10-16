import { Queue, type Job } from 'bullmq';
import { getBullConnectionOptions } from '../connection.js';
import {
  BullQueueName,
  DEFAULT_BULLMQ_JOB_OPTIONS,
  type ReservationExpiryJobData,
  ReservationExpiryJobDataSchema,
} from '../types/bullmq.types.js';
import { logger } from '../../config/logger.js';

export class ReservationExpiryQueue {
  private queueInstance: Queue<ReservationExpiryJobData> | null = null;

  public getQueue(): Queue<ReservationExpiryJobData> {
    if (!this.queueInstance) {
      this.queueInstance = new Queue<ReservationExpiryJobData>(BullQueueName.RESERVATION_EXPIRY, {
        connection: getBullConnectionOptions(),
        defaultJobOptions: DEFAULT_BULLMQ_JOB_OPTIONS,
      });

      this.queueInstance.on('error', (err) => {
        logger.error({ queue: BullQueueName.RESERVATION_EXPIRY, err: err.message }, 'BullMQ Queue error');
      });
    }
    return this.queueInstance;
  }

  public async enqueueExpiryReconciliation(
    data: Partial<ReservationExpiryJobData> = {},
    customJobId?: string,
  ): Promise<Job<ReservationExpiryJobData>> {
    const queue = this.getQueue();
    const validated = ReservationExpiryJobDataSchema.parse({
      triggeredAt: data.triggeredAt ?? Date.now(),
      batchSize: data.batchSize ?? 50,
    });

    const job = await queue.add('reconcile-expired-reservations', validated, {
      jobId: customJobId,
    });

    logger.debug(
      { queue: BullQueueName.RESERVATION_EXPIRY, jobId: job.id, batchSize: validated.batchSize },
      'Enqueued reservation expiry reconciliation job',
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

export const reservationExpiryQueue = new ReservationExpiryQueue();
