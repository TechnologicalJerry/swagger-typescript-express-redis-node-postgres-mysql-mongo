import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../db/redis/client.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ReservationExpiryJob, reservationExpiryJob } from './reservation-expiry.job.js';

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class ReservationExpiryScheduler {
  private readonly redis: Redis;
  private readonly job: ReservationExpiryJob;
  public readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  public readonly lockKey = 'lock:job:reservation-expiry';
  public readonly lockTtlMs = 25000;

  constructor(
    job: ReservationExpiryJob = reservationExpiryJob,
    redisInstance: Redis = redis,
    intervalMs: number = env.RESERVATION_RECOVERY_INTERVAL_MS,
  ) {
    this.job = job;
    this.redis = redisInstance;
    this.intervalMs = intervalMs;
  }

  /**
   * Attempts to acquire distributed lock for multi-instance scheduler coordination.
   */
  private async acquireLock(): Promise<string | null> {
    const lockToken = crypto.randomUUID();
    try {
      const res = await this.redis.set(this.lockKey, lockToken, 'PX', this.lockTtlMs, 'NX');
      return res === 'OK' ? lockToken : null;
    } catch (err: unknown) {
      logger.warn({ err }, 'Error attempting to acquire reservation expiry scheduler lock');
      return null;
    }
  }

  /**
   * Releases distributed lock safely using compare-and-delete Lua script.
   */
  private async releaseLock(lockToken: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey, lockToken);
    } catch (err: unknown) {
      logger.warn({ err }, 'Error releasing reservation expiry scheduler lock');
    }
  }

  /**
   * Executes a single scheduler tick with in-process overlap protection and distributed locking.
   */
  public async tick(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Skipping reservation expiry tick; previous run is still in progress');
      return;
    }

    this.isRunning = true;
    let lockToken: string | null = null;

    try {
      lockToken = await this.acquireLock();
      if (!lockToken) {
        logger.debug('Skipping reservation expiry tick; another worker holds the lock');
        return;
      }

      const result = await this.job.runExpiryReconciliation();
      if (result.status === 'SUCCESS' && result.expiredCount > 0) {
        logger.info(
          { scannedCount: result.scannedCount, expiredCount: result.expiredCount },
          'Reservation expiry reconciliation cycle completed successfully',
        );
      }
    } catch (err: unknown) {
      logger.error({ err }, 'Unhandled error in reservation expiry scheduler tick');
    } finally {
      if (lockToken) {
        await this.releaseLock(lockToken);
      }
      this.isRunning = false;
    }
  }

  /**
   * Starts the periodic background scheduler.
   */
  public start(): void {
    if (this.timer) {
      return;
    }

    logger.info({ intervalMs: this.intervalMs }, 'Starting reservation expiry reconciliation scheduler');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Unref timer so it does not keep Node process alive on shutdown
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops the periodic background scheduler.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Stopped reservation expiry reconciliation scheduler');
    }
  }
}

export const reservationExpiryScheduler = new ReservationExpiryScheduler();
