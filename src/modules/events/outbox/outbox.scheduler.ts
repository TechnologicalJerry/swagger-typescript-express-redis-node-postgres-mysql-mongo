import { OutboxService, outboxService } from './outbox.service.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';

export class OutboxScheduler {
  private readonly service: OutboxService;
  public readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(
    service: OutboxService = outboxService,
    intervalMs: number = env.OUTBOX_POLL_INTERVAL_MS,
  ) {
    this.service = service;
    this.intervalMs = intervalMs;
  }

  public async tick(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      const result = await this.service.dispatchPendingEvents();
      if (result.dispatched > 0) {
        logger.info(
          { dispatched: result.dispatched, failed: result.failed },
          'Outbox dispatcher completed cycle',
        );
      }
    } catch (err: unknown) {
      logger.error({ err }, 'Unhandled error in outbox scheduler tick');
    } finally {
      this.isRunning = false;
    }
  }

  public start(): void {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Starting transactional outbox dispatcher scheduler');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Stopped transactional outbox dispatcher scheduler');
    }
  }
}

export const outboxScheduler = new OutboxScheduler();
