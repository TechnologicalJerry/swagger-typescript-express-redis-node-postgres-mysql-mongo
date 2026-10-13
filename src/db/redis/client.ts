import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger, redactConnectionString } from '../../config/logger.js';

export class RedisClient {
  private static instance: RedisClient | null = null;
  public readonly client: Redis;

  private constructor() {
    this.client = new Redis(env.REDIS_URL, {
      connectTimeout: 5000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    const redactedEndpoint = redactConnectionString(env.REDIS_URL);

    this.client.on('connect', () => {
      logger.info({ endpoint: redactedEndpoint }, 'Redis client connected');
    });

    this.client.on('ready', () => {
      logger.info({ endpoint: redactedEndpoint }, 'Redis client ready');
    });

    this.client.on('error', (err: Error) => {
      // Ensure raw connection string and sensitive credentials are never leaked
      logger.error(
        { endpoint: redactedEndpoint, message: err.message },
        'Redis client connection error',
      );
    });

    this.client.on('close', () => {
      logger.info({ endpoint: redactedEndpoint }, 'Redis client connection closed');
    });
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  public async connect(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  /**
   * Health check using the canonical Redis PING command.
   * Expects PONG response within bounded timeout.
   */
  public async checkHealth(): Promise<void> {
    await this.connect();
    const result = await this.client.ping();
    if (result !== 'PONG') {
      throw new Error(`Unexpected Redis PING response: ${result}`);
    }
  }

  public async disconnect(): Promise<void> {
    logger.info('Disconnecting Redis client');
    try {
      if (this.client.status !== 'end') {
        await this.client.quit();
      }
    } catch {
      this.client.disconnect();
    }
  }
}

export const redisClient = RedisClient.getInstance();
export const redis = redisClient.client;
