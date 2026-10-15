import type { Job } from 'bullmq';
import {
  type ReservationExpiryJobData,
  ReservationExpiryJobDataSchema,
} from '../types/bullmq.types.js';
import { ReservationExpiryJob, reservationExpiryJob } from '../reservation-expiry.job.js';
import { logger } from '../../config/logger.js';
import type { ReservationExpiryJobResult } from '../../modules/inventory/reservation.types.js';

export class ReservationExpiryProcessor {
  private readonly jobRunner: ReservationExpiryJob;

  constructor(jobRunner: ReservationExpiryJob = reservationExpiryJob) {
    this.jobRunner = jobRunner;
  }

  public async process(job: Job<ReservationExpiryJobData>): Promise<ReservationExpiryJobResult> {
    const validatedData = ReservationExpiryJobDataSchema.parse(job.data);

    logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
        batchSize: validatedData.batchSize,
      },
      'Processing reservation expiry reconciliation job',
    );

    try {
      const result = await this.jobRunner.runExpiryReconciliation(validatedData.batchSize);

      logger.info(
        {
          jobId: job.id,
          status: result.status,
          scannedCount: result.scannedCount,
          expiredCount: result.expiredCount,
        },
        'Reservation expiry reconciliation job completed',
      );

      if (result.status === 'PARTIAL_FAILURE' && result.errors && result.errors.length > 0) {
        logger.warn(
          { jobId: job.id, errors: result.errors },
          'Partial failures encountered during reservation expiry reconciliation',
        );
      }

      return result;
    } catch (err: unknown) {
      const sanitizedMessage = err instanceof Error ? err.message : 'Unknown reconciliation error';
      logger.error(
        {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          err: sanitizedMessage,
        },
        'Reservation expiry reconciliation processor failed',
      );
      throw err;
    }
  }
}

export const reservationExpiryProcessor = new ReservationExpiryProcessor();
