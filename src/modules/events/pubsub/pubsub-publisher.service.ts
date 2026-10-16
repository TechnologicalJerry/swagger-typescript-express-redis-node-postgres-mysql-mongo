import type { Redis } from 'ioredis';
import { redis } from '../../../db/redis/client.js';
import { logger } from '../../../config/logger.js';
import { domainEventEnvelopeSchema, sanitizeEventPayload } from '../event.schema.js';
import type { DomainEvent, PubSubChannel } from '../event.types.js';

export class EventPubSubPublisher {
  private readonly redis: Redis;

  constructor(redisInstance: Redis = redis) {
    this.redis = redisInstance;
  }

  /**
   * Publishes a validated domain event to a Redis Pub/Sub channel.
   *
   * Redis command:
   *   PUBLISH <channel> <message>
   *
   * Semantics:
   *   - Fire-and-forget / At-most-once delivery.
   *   - Redis pushes the message immediately to all connected clients subscribed to the channel.
   *   - If a subscriber is disconnected or restarting, the message is NOT retained or redelivered.
   *   - Suitable for real-time notifications, UI updates, and cache invalidation hints.
   *
   * Returns:
   *   The number of active subscribers that received the message.
   */
  public async publish<T extends Record<string, unknown>>(
    channel: PubSubChannel | string,
    event: DomainEvent<T>,
  ): Promise<number> {
    // 1. Validate envelope contract
    const validated = domainEventEnvelopeSchema.parse(event) as DomainEvent<T>;

    // 2. Sanitize payload to guarantee no credentials or secrets are broadcast
    const sanitizedEvent: DomainEvent<T> = {
      ...validated,
      payload: sanitizeEventPayload(validated.payload),
    };

    const payloadString = JSON.stringify(sanitizedEvent);

    try {
      // PUBLISH channel message
      const subscriberCount = await this.redis.publish(channel, payloadString);

      logger.debug(
        {
          eventId: sanitizedEvent.eventId,
          eventType: sanitizedEvent.eventType,
          channel,
          subscriberCount,
          correlationId: sanitizedEvent.correlationId,
        },
        'Published domain event to Redis Pub/Sub channel',
      );

      return subscriberCount;
    } catch (err: unknown) {
      logger.error(
        {
          err,
          eventId: sanitizedEvent.eventId,
          eventType: sanitizedEvent.eventType,
          channel,
        },
        'Failed to publish event to Redis Pub/Sub channel',
      );
      throw err;
    }
  }
}

export const eventPubSubPublisher = new EventPubSubPublisher();
