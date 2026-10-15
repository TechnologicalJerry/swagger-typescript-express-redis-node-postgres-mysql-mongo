import type { ConnectionOptions } from 'bullmq';
import { env } from '../config/env.js';

/**
 * Returns connection options configured specifically for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` to support blocking Redis commands
 * (such as BRPOPLPUSH/BZPOPMIN) without hitting command retry limits.
 *
 * Providing connection options rather than an externally instantiated ioredis client
 * allows BullMQ to manage the lifecycle of internal connections cleanly on worker/queue close.
 */
export function getBullConnectionOptions(): ConnectionOptions {
  try {
    const parsed = new URL(env.REDIS_URL);
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}
