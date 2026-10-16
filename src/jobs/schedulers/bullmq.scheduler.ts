import { productViewQueue } from '../queues/product-view.queue.js';
import { reservationExpiryQueue } from '../queues/reservation-expiry.queue.js';
import { outboxDispatchQueue } from '../queues/outbox-dispatch.queue.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export class BullSchedulerService {
  private isStarted = false;

  public async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    try {
      logger.info('Registering BullMQ repeatable job schedulers...');

      // 1. Product view counter aggregation repeatable scheduler
      const pvQueue = productViewQueue.getQueue();
      await pvQueue.upsertJobScheduler(
        'product-view-aggregation-scheduler',
        { every: env.PRODUCT_VIEW_AGGREGATION_INTERVAL_MS },
        {
          name: 'aggregate-views',
          data: {
            triggeredAt: Date.now(),
            batchSize: env.PRODUCT_VIEW_BATCH_SIZE,
          },
        },
      );

      // 2. Reservation expiry reconciliation repeatable scheduler
      const reQueue = reservationExpiryQueue.getQueue();
      await reQueue.upsertJobScheduler(
        'reservation-expiry-scheduler',
        { every: env.RESERVATION_RECOVERY_INTERVAL_MS },
        {
          name: 'reconcile-expired-reservations',
          data: {
            triggeredAt: Date.now(),
            batchSize: 50,
          },
        },
      );

      // 3. Outbox event dispatch repeatable scheduler
      const obQueue = outboxDispatchQueue.getQueue();
      await obQueue.upsertJobScheduler(
        'outbox-dispatch-scheduler',
        { every: 5000 },
        {
          name: 'dispatch-outbox-events',
          data: {
            triggeredAt: Date.now(),
            batchSize: 20,
          },
        },
      );

      this.isStarted = true;
      logger.info('BullMQ repeatable job schedulers successfully registered in Redis');
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to register BullMQ repeatable job schedulers');
      throw err;
    }
  }

  public async stop(): Promise<void> {
    this.isStarted = false;
    logger.info('BullMQ scheduler service stopped');
  }
}

export const bullSchedulerService = new BullSchedulerService();
