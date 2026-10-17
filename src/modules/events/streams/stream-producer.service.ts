import type { Redis } from 'ioredis';
import { redis } from '../../../db/redis/client.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { domainEventEnvelopeSchema, sanitizeEventPayload } from '../event.schema.js';
import type { DomainEvent } from '../event.types.js';

export class EventStreamProducer {
  private readonly redis: Redis;
  public readonly streamKey: string;
  public readonly maxLen: number;

  constructor(
    redisInstance: Redis = redis,
    streamKey: string = env.REDIS_STREAM_DOMAIN_EVENTS,
    maxLen: number = env.REDIS_STREAM_MAX_LEN,
  ) {
    this.redis = redisInstance;
    this.streamKey = streamKey;
    this.maxLen = maxLen;
  }

  /**
   * Appends a validated domain event to a durable Redis Stream.
   *
   * Redis command:
   *   XADD <streamKey> MAXLEN ~ <maxLen> * <field1> <val1> ...
   *
   * Semantics:
   *   - Durable log: Unlike Pub/Sub, Redis Streams retain messages on disk according to RDB/AOF.
   *   - '*' generates an automatic millisecond timestamp + sequence entry ID (e.g. 1773000000000-0).
   *   - 'MAXLEN ~ 10000' applies approximate trimming to cap stream memory usage efficiently
   *     without incurring exact re-indexing overhead on every append.
   *   - Supports Consumer Groups (XREADGROUP), acknowledgements (XACK), and recovery of unacked entries (XPENDING/XCLAIM).
   *
   * Returns:
   *   The generated stream entry ID.
   */
  public async appendEvent<T extends Record<string, unknown>>(
    event: DomainEvent<T>,
    streamKey: string = this.streamKey,
  ): Promise<string> {
    // 1. Validate envelope contract
    const validated = domainEventEnvelopeSchema.parse(event) as DomainEvent<T>;

    // 2. Sanitize payload
    const sanitizedPayload = sanitizeEventPayload(validated.payload);

    try {
      // XADD streamKey MAXLEN ~ maxLen * eventId ... eventType ... payload ...
      const entryId = await this.redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        this.maxLen,
        '*',
        'eventId',
        validated.eventId,
        'eventType',
        validated.eventType,
        'eventVersion',
        String(validated.eventVersion),
        'occurredAt',
        validated.occurredAt,
        'producer',
        validated.producer,
        'correlationId',
        validated.correlationId || '',
        'payload',
        JSON.stringify(sanitizedPayload),
      );

      logger.debug(
        {
          streamKey,
          entryId,
          eventId: validated.eventId,
          eventType: validated.eventType,
        },
        'Appended event entry to Redis Stream',
      );

      if (!entryId) {
        throw new Error('Redis XADD did not return an entry ID');
      }

      return entryId;
    } catch (err: unknown) {
      logger.error(
        {
          err,
          streamKey,
          eventId: validated.eventId,
          eventType: validated.eventType,
        },
        'Failed to append event entry to Redis Stream',
      );
      throw err;
    }
  }
}

export const eventStreamProducer = new EventStreamProducer();
