import crypto from 'node:crypto';
import { EventPubSubPublisher, eventPubSubPublisher } from './pubsub/pubsub-publisher.service.js';
import { EventStreamProducer, eventStreamProducer } from './streams/stream-producer.service.js';
import { logger } from '../../config/logger.js';
import { PubSubChannel, type DomainEvent } from './event.types.js';

export class EventPublisherService {
  private readonly pubsub: EventPubSubPublisher;
  private readonly streams: EventStreamProducer;

  constructor(
    pubsub: EventPubSubPublisher = eventPubSubPublisher,
    streams: EventStreamProducer = eventStreamProducer,
  ) {
    this.pubsub = pubsub;
    this.streams = streams;
  }

  /**
   * Publishes a domain event across both Redis messaging layers:
   * 1. Redis Pub/Sub: immediate, transient broadcast for cache invalidation & real-time notifications.
   * 2. Redis Streams: durable, retained stream entry for asynchronous consumer-group processing & audit logging.
   *
   * Failure Isolation:
   * If Redis experiences a transient error after a database transaction has successfully committed,
   * the failure is logged with complete event context, preserving the committed database state.
   */
  public async publishDomainEvent<T extends Record<string, unknown>>(
    channel: PubSubChannel | string,
    event: DomainEvent<T>,
  ): Promise<{ pubsubDelivered: number; streamEntryId: string | null }> {
    let pubsubDelivered = 0;
    let streamEntryId: string | null = null;

    try {
      // 1. Broadcast via Pub/Sub
      pubsubDelivered = await this.pubsub.publish(channel, event);
    } catch (pubsubErr: unknown) {
      logger.warn(
        { pubsubErr, eventId: event.eventId, channel },
        'Warning: Failed to broadcast event via Redis Pub/Sub',
      );
    }

    try {
      // 2. Append to Redis Stream
      streamEntryId = await this.streams.appendEvent(event);
    } catch (streamErr: unknown) {
      logger.error(
        { streamErr, eventId: event.eventId, eventType: event.eventType },
        'Warning: Failed to append event to Redis Stream',
      );
    }

    return { pubsubDelivered, streamEntryId };
  }

  /**
   * Factory helper to construct a standardized, versioned DomainEvent envelope.
   */
  public createEvent<T extends Record<string, unknown>>(
    eventType: string,
    producer: string,
    payload: T,
    correlationId?: string,
  ): DomainEvent<T> {
    return {
      eventId: crypto.randomUUID(),
      eventType,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
      producer,
      payload,
    };
  }
}

export const eventPublisherService = new EventPublisherService();
