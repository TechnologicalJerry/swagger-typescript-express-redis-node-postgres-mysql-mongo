import { productViewWorker, ProductViewWorker } from './product-view.worker.js';
import { reservationExpiryWorker, ReservationExpiryWorker } from './reservation-expiry.worker.js';
import { outboxDispatchWorker, OutboxDispatchWorker } from './outbox-dispatch.worker.js';
import { productViewQueue } from '../queues/product-view.queue.js';
import { reservationExpiryQueue } from '../queues/reservation-expiry.queue.js';
import { outboxDispatchQueue } from '../queues/outbox-dispatch.queue.js';
import { logger } from '../../config/logger.js';

export class BullWorkerManager {
  private readonly productWorker: ProductViewWorker;
  private readonly reservationWorker: ReservationExpiryWorker;
  private readonly outboxWorker: OutboxDispatchWorker;

  constructor(
    productWorker: ProductViewWorker = productViewWorker,
    reservationWorker: ReservationExpiryWorker = reservationExpiryWorker,
    outboxWorker: OutboxDispatchWorker = outboxDispatchWorker,
  ) {
    this.productWorker = productWorker;
    this.reservationWorker = reservationWorker;
    this.outboxWorker = outboxWorker;
  }

  public startAll(): void {
    logger.info('Starting all BullMQ workers...');
    this.productWorker.start();
    this.reservationWorker.start();
    this.outboxWorker.start();
    logger.info('All BullMQ workers started');
  }

  public async stopAll(): Promise<void> {
    logger.info('Stopping all BullMQ workers and queues...');
    await Promise.allSettled([
      this.productWorker.close(),
      this.reservationWorker.close(),
      this.outboxWorker.close(),
      productViewQueue.close(),
      reservationExpiryQueue.close(),
      outboxDispatchQueue.close(),
    ]);
    logger.info('All BullMQ workers and queues stopped');
  }
}

export const bullWorkerManager = new BullWorkerManager();
