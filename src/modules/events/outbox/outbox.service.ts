import { postgresDb } from '../../../db/postgres/client.js';
import { eventPubSubPublisher } from '../pubsub/pubsub-publisher.service.js';
import { eventStreamProducer } from '../streams/stream-producer.service.js';
import { logger } from '../../../config/logger.js';
import type { DomainEvent } from '../event.types.js';

interface RawOutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  channel: string;
  payload: unknown;
  status: string;
  retry_count: number;
  created_at: Date | string;
}

export class OutboxService {
  /**
   * Records a domain event into the PostgreSQL transactional outbox table.
   * MUST be executed within the caller's active PostgreSQL transaction ($transaction tx)
   * to guarantee that business state changes and event creation commit atomically.
   */
  public async recordOutboxEvent<T extends Record<string, unknown>>(
    tx: { $queryRawUnsafe: typeof postgresDb.$queryRawUnsafe },
    event: DomainEvent<T>,
    channel: string,
  ): Promise<void> {
    try {
      await tx.$queryRawUnsafe(
        `INSERT INTO outbox_events (
           id, event_id, event_type, channel, payload, status, retry_count, created_at
         )
         VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, 'PENDING'::"OutboxStatus", 0, NOW())`,
        event.eventId,
        event.eventType,
        channel,
        JSON.stringify(event),
      );

      logger.debug(
        { eventId: event.eventId, eventType: event.eventType, channel },
        'Recorded transactional outbox event in PostgreSQL',
      );
    } catch (err: unknown) {
      logger.error(
        { err, eventId: event.eventId, eventType: event.eventType },
        'Failed to record transactional outbox event in PostgreSQL',
      );
      throw err;
    }
  }

  /**
   * Scans and dispatches pending outbox events to Redis Pub/Sub and Redis Streams.
   * Updates outbox status to PUBLISHED upon successful dispatch.
   */
  public async dispatchPendingEvents(batchSize: number = 20): Promise<{ dispatched: number; failed: number }> {
    let dispatched = 0;
    let failed = 0;

    try {
      const rows = await postgresDb.$queryRawUnsafe<RawOutboxRow[]>(
        `SELECT id, event_id, event_type, channel, payload, status, retry_count, created_at
         FROM outbox_events
         WHERE status = 'PENDING'::"OutboxStatus"
         ORDER BY created_at ASC
         LIMIT $1`,
        batchSize,
      );

      if (!rows || rows.length === 0) {
        return { dispatched: 0, failed: 0 };
      }

      for (const row of rows) {
        let domainEvent: DomainEvent;
        try {
          domainEvent = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        } catch {
          await postgresDb.$queryRawUnsafe(
            `UPDATE outbox_events
             SET status = 'FAILED'::"OutboxStatus", error_message = 'Malformed payload JSON'
             WHERE id = $1`,
            row.id,
          );
          failed++;
          continue;
        }

        try {
          // 1. Publish to Redis Pub/Sub for transient consumers
          await eventPubSubPublisher.publish(row.channel, domainEvent);

          // 2. Append to Redis Stream for durable audit logging
          await eventStreamProducer.appendEvent(domainEvent);

          // 3. Mark outbox entry as PUBLISHED
          await postgresDb.$queryRawUnsafe(
            `UPDATE outbox_events
             SET status = 'PUBLISHED'::"OutboxStatus", published_at = NOW(), error_message = NULL
             WHERE id = $1`,
            row.id,
          );

          dispatched++;
        } catch (dispatchErr: unknown) {
          const errMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
          const newRetryCount = Number(row.retry_count) + 1;
          const newStatus = newRetryCount >= 5 ? 'FAILED' : 'PENDING';

          await postgresDb.$queryRawUnsafe(
            `UPDATE outbox_events
             SET retry_count = $1, status = $2::"OutboxStatus", error_message = $3
             WHERE id = $4`,
            newRetryCount,
            newStatus,
            errMsg,
            row.id,
          );

          failed++;
          logger.warn(
            { dispatchErr, eventId: row.event_id, retryCount: newRetryCount },
            'Failed to dispatch outbox event to Redis; will retry on next cycle',
          );
        }
      }
    } catch (err: unknown) {
      logger.error({ err }, 'Error during outbox event dispatch cycle');
    }

    return { dispatched, failed };
  }
}

export const outboxService = new OutboxService();
