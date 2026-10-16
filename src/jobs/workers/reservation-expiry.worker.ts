import { Worker, type Job } from 'bullmq';
import { getBullConnectionOptions } from '../connection.js';
import { BullQueueName, type ReservationExpiryJobData } from '../types/bullmq.types.js';
import {
  ReservationExpiryProcessor,
  reservationExpiryProcessor,
} from '../processors/reservation-expiry.processor.js';
import { logger } from '../../config/logger.js';

export class ReservationExpiryWorker {
  private workerInstance: Worker<ReservationExpiryJobData> | null = null;
  private readonly processor: ReservationExpiryProcessor;

  constructor(processor: ReservationExpiryProcessor = reservationExpiryProcessor) {
    this.processor = processor;
  }

  public start(): Worker<ReservationExpiryJobData> {
    if (this.workerInstance) {
      return this.workerInstance;
    }

    this.workerInstance = new Worker<ReservationExpiryJobData>(
      BullQueueName.RESERVATION_EXPIRY,
      async (job: Job<ReservationExpiryJobData>) => {
        return this.processor.process(job);
      },
      {
        connection: getBullConnectionOptions(),
        concurrency: 1, // Concurrency 1 ensures reconciliation runs sequentially
      },
    );

    this.workerInstance.on('completed', (job) => {
      logger.info(
        { queue: BullQueueName.RESERVATION_EXPIRY, jobId: job.id, returnValue: job.returnvalue },
        'Job completed successfully',
      );
    });

    this.workerInstance.on('failed', (job, err) => {
      logger.error(
        {
          queue: BullQueueName.RESERVATION_EXPIRY,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          err: err.message,
        },
        'Job failed',
      );
    });

    this.workerInstance.on('error', (err) => {
      logger.error({ queue: BullQueueName.RESERVATION_EXPIRY, err: err.message }, 'BullMQ Worker error');
    });

    logger.info({ queue: BullQueueName.RESERVATION_EXPIRY }, 'Reservation expiry worker started');
    return this.workerInstance;
  }

  public async close(): Promise<void> {
    if (this.workerInstance) {
      logger.info({ queue: BullQueueName.RESERVATION_EXPIRY }, 'Stopping reservation expiry worker');
      await this.workerInstance.close();
      this.workerInstance = null;
    }
  }

  public isRunning(): boolean {
    return this.workerInstance !== null && this.workerInstance.isRunning();
  }
}

export const reservationExpiryWorker = new ReservationExpiryWorker();
