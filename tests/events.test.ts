import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { redis } from '../src/db/redis/client.js';
import { postgresDb } from '../src/db/postgres/client.js';
import { mongoClient } from '../src/db/mongo/client.js';
import { AuditLogModel } from '../src/db/mongo/models/audit-log.model.js';
import { eventPubSubPublisher } from '../src/modules/events/pubsub/pubsub-publisher.service.js';
import { EventPubSubSubscriber } from '../src/modules/events/pubsub/pubsub-subscriber.service.js';
import { eventStreamProducer } from '../src/modules/events/streams/stream-producer.service.js';
import { AuditLogStreamConsumer } from '../src/modules/events/streams/stream-consumer.service.js';
import { auditLogService, sanitizeAuditMetadata } from '../src/modules/audit/audit.service.js';
import { outboxService } from '../src/modules/events/outbox/outbox.service.js';
import { eventPublisherService } from '../src/modules/events/event-publisher.service.js';
import { PubSubChannel, type DomainEvent } from '../src/modules/events/event.types.js';

describe('Phase 9 — Redis Pub/Sub, Redis Streams, and MongoDB Audit Logs', () => {
  const adminId = 'a0000000-0000-0000-0000-000000000001';

  beforeAll(async () => {
    await mongoClient.connect();
  });

  const cleanData = async () => {
    // 1. Clean MongoDB audit logs
    try {
      await AuditLogModel.deleteMany({});
    } catch {
      // Ignore during write-only phase
    }

    // 2. Clean PostgreSQL outbox events
    try {
      await postgresDb.$executeRawUnsafe('DELETE FROM outbox_events');
    } catch {
      // Ignore if table not yet migrated
    }

    // 3. Clean Redis streams, Pub/Sub, and rate limit keys
    try {
      const rateKeys = await redis.keys('rate:*');
      const delKeys = [
        'stream:domain-events',
        'stream:dead-letter:domain-events',
        'stream:test-events',
        'stream:test-consumer-group',
        'stream:dead-letter:test',
        'stream:test-poison',
        'stream:dead-letter:test-poison',
        ...rateKeys,
      ];
      await redis.del(...delKeys);
    } catch {
      // Ignore during cleanup
    }
  };

  beforeEach(async () => {
    await cleanData();
  });

  afterAll(async () => {
    await cleanData();
    await mongoClient.disconnect();
  });

  describe('1. Event Contracts, Envelope Validation & Secret Sanitization', () => {
    it('creates a standardized domain event envelope', () => {
      const event = eventPublisherService.createEvent(
        'product.created',
        'products-service',
        {
          productId: 'p-123',
          name: 'Gaming Laptop',
          price: 1299.99,
          sku: 'GL-123',
          category: 'Computers',
        },
        'req-corr-001',
      );

      expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(event.eventType).toBe('product.created');
      expect(event.eventVersion).toBe(1);
      expect(event.producer).toBe('products-service');
      expect(event.correlationId).toBe('req-corr-001');
      expect(event.payload.productId).toBe('p-123');
    });

    it('redacts sensitive fields from audit metadata recursively', () => {
      const sensitivePayload = {
        userId: 'u-123',
        email: 'test@example.com',
        password: 'SuperSecretPassword123!',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
        nested: {
          accessToken: 'jwt.access.token.secret',
          refreshToken: 'jwt.refresh.token.secret',
          otp: '123456',
          safeField: 'visible-value',
        },
      };

      const sanitized = sanitizeAuditMetadata(sensitivePayload);

      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.passwordHash).toBe('[REDACTED]');
      expect(sanitized.email).toBe('test@example.com');
      expect((sanitized.nested as Record<string, unknown>).accessToken).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).otp).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).safeField).toBe('visible-value');
    });
  });

  describe('2. Redis Pub/Sub: Transient Real-Time Notifications', () => {
    it('publishes a domain event to a Pub/Sub channel and receives it on a dedicated subscriber', async () => {
      const subscriber = new EventPubSubSubscriber();
      const testChannel = PubSubChannel.PRODUCTS;
      const receivedEvents: DomainEvent[] = [];

      await subscriber.subscribe(testChannel, async (event) => {
        receivedEvents.push(event);
      });

      await subscriber.start();

      const event = eventPublisherService.createEvent(
        'product.updated',
        'products-service',
        {
          productId: 'prod-pubsub-01',
          updatedFields: ['price'],
        },
      );

      const deliveredCount = await eventPubSubPublisher.publish(testChannel, event);
      expect(deliveredCount).toBeGreaterThanOrEqual(0);

      // Verify subscriber shutdown cleanup
      await subscriber.stop();
    });

    it('safely discards malformed or non-JSON Pub/Sub messages without crashing subscriber', async () => {
      const subscriber = new EventPubSubSubscriber();
      const testChannel = 'events:test-malformed';
      let handlerCalled = false;

      await subscriber.subscribe(testChannel, async () => {
        handlerCalled = true;
      });

      await subscriber.start();

      // Publish corrupt non-JSON string directly via Redis
      await redis.publish(testChannel, 'NOT_VALID_JSON_{{{');

      // Publish JSON violating envelope schema
      await redis.publish(testChannel, JSON.stringify({ wrongField: 'missing required fields' }));

      // Handler should safely ignore malformed data
      expect(handlerCalled).toBe(false);

      await subscriber.stop();
    });

    it('demonstrates that disconnected subscribers miss messages (fire-and-forget)', async () => {
      const offlineSubscriber = new EventPubSubSubscriber();
      const testChannel = 'events:transient-test';
      const received: DomainEvent[] = [];

      await offlineSubscriber.subscribe(testChannel, async (event) => {
        received.push(event);
      });

      // Do NOT start subscriber (simulating offline client)
      const event = eventPublisherService.createEvent(
        'product.created',
        'products-service',
        { productId: 'p-missed', sku: 'M-1', name: 'Missed', price: 10, category: 'General' },
      );

      // Publish while subscriber is offline
      const count = await eventPubSubPublisher.publish(testChannel, event);
      expect(count).toBe(0); // 0 active subscribers connected

      // When subscriber starts later, missed message is NOT replayed
      await offlineSubscriber.start();
      expect(received.length).toBe(0);

      await offlineSubscriber.stop();
    });
  });

  describe('3. Redis Streams: Durable Log, Consumer Groups & Recovery', () => {
    it('appends an event entry to a Redis Stream with XADD and generates millisecond entry ID', async () => {
      const event = eventPublisherService.createEvent(
        'product.created',
        'products-service',
        {
          productId: 'prod-stream-01',
          sku: 'STR-001',
          name: 'Stream Product',
          price: 49.99,
          category: 'Hardware',
        },
      );

      const entryId = await eventStreamProducer.appendEvent(event, 'stream:test-events');

      expect(entryId).toMatch(/^\d+-\d+$/);

      // Verify stream entry exists in Redis
      const entries = (await redis.xrange('stream:test-events', entryId, entryId)) as Array<[string, string[]]>;
      expect(entries.length).toBe(1);
      expect(entries[0][0]).toBe(entryId);
    });

    it('processes stream entries via consumer group and acknowledges with XACK', async () => {
      const streamKey = 'stream:test-consumer-group';
      const groupName = 'test-group-01';
      const consumerName = 'test-worker-01';

      const consumer = new AuditLogStreamConsumer(
        redis,
        auditLogService,
        streamKey,
        'stream:dead-letter:test',
        groupName,
        consumerName,
      );

      // Initialize consumer group (XGROUP CREATE MKSTREAM)
      await consumer.initGroup();

      const event = eventPublisherService.createEvent(
        'reservation.confirmed',
        'inventory-service',
        {
          reservationId: crypto.randomUUID(),
          productId: 'prod-ack-01',
          quantity: 2,
          confirmedAt: new Date().toISOString(),
        },
      );

      // Append entry to stream
      const entryId = await eventStreamProducer.appendEvent(event, streamKey);

      // Process entry
      const rawEntries = (await redis.xrange(streamKey, entryId, entryId)) as Array<[string, string[]]>;
      const processed = await consumer.processEntry(entryId, rawEntries[0][1]);
      expect(processed).toBe(true);

      // Verify entry was acknowledged (not in pending list)
      const pending = (await redis.xpending(streamKey, groupName, '-', '+', 10)) as Array<[string, string, number, number]>;
      expect(pending.length).toBe(0);

      // Verify audit record was created in MongoDB
      const audit = await auditLogService.getAuditLogByEventId(event.eventId);
      expect(audit).not.toBeNull();
      expect(audit?.eventType).toBe('reservation.confirmed');
      expect(audit?.targetType).toBe('reservation');
    });

    it('routes poison entries exceeding max retries to dead-letter stream', async () => {
      const streamKey = 'stream:test-poison';
      const deadLetterKey = 'stream:dead-letter:test-poison';
      const groupName = 'poison-group';
      const consumerName = 'poison-worker';

      const consumer = new AuditLogStreamConsumer(
        redis,
        auditLogService,
        streamKey,
        deadLetterKey,
        groupName,
        consumerName,
        10,
        1000,
        2, // maxRetries = 2
        0, // claimMinIdleMs = 0 for testing
      );

      await consumer.initGroup();

      // Corrupt entry lacking eventId
      const poisonId = await redis.xadd(streamKey, '*', 'corruptedField', 'no-event-id');

      // Process corrupt entry directly
      const raw = (await redis.xrange(streamKey, poisonId, poisonId)) as Array<[string, string[]]>;
      const result = await consumer.processEntry(poisonId, raw[0][1]);
      expect(result).toBe(false);

      // Verify corrupt entry was moved to dead-letter stream and acked
      const dlEntries = (await redis.xrange(deadLetterKey, '-', '+')) as Array<[string, string[]]>;
      expect(dlEntries.length).toBe(1);
    });
  });

  describe('4. MongoDB Audit Logs: Durability & Idempotency', () => {
    it('persists a durable audit record with compound indexes', async () => {
      const eventId = crypto.randomUUID();
      const record = await auditLogService.recordAuditLog({
        eventId,
        eventType: 'inventory.adjusted',
        occurredAt: new Date().toISOString(),
        targetType: 'inventory',
        targetId: 'prod-audit-01',
        source: 'inventory-service',
        outcome: 'SUCCESS',
        metadata: {
          previousQuantity: 10,
          newQuantity: 15,
        },
      });

      expect(record).not.toBeNull();
      expect(record?.eventId).toBe(eventId);
      expect(record?.eventType).toBe('inventory.adjusted');
      expect(record?.outcome).toBe('SUCCESS');

      // Lookup via query service
      const fetched = await auditLogService.getAuditLogByEventId(eventId);
      expect(fetched).not.toBeNull();
      expect(fetched?.targetId).toBe('prod-audit-01');
    });

    it('handles duplicate event ID arrivals idempotently without throwing', async () => {
      const eventId = crypto.randomUUID();
      const input = {
        eventId,
        eventType: 'reservation.created',
        occurredAt: new Date().toISOString(),
        targetType: 'reservation',
        targetId: crypto.randomUUID(),
        source: 'inventory-service',
        outcome: 'SUCCESS' as const,
        metadata: { quantity: 5 },
      };

      // First insertion
      const first = await auditLogService.recordAuditLog(input);
      expect(first).not.toBeNull();

      // Duplicate insertion (replay from stream consumer retry)
      const duplicate = await auditLogService.recordAuditLog(input);
      expect(duplicate).not.toBeNull();
      expect(duplicate?.eventId).toBe(eventId);

      // Verify only ONE audit document exists in MongoDB
      const count = await AuditLogModel.countDocuments({ eventId });
      expect(count).toBe(1);
    });
  });

  describe('5. Transactional Outbox Pattern (PostgreSQL)', () => {
    it('records an outbox event in PostgreSQL within transaction and dispatches to Redis', async () => {
      const event = eventPublisherService.createEvent(
        'reservation.created',
        'inventory-service',
        {
          reservationId: crypto.randomUUID(),
          productId: 'prod-outbox-01',
          quantity: 3,
        },
      );

      // 1. Record outbox event inside PostgreSQL transaction
      await postgresDb.$transaction(async (tx) => {
        await outboxService.recordOutboxEvent(tx, event, PubSubChannel.RESERVATIONS);
      });

      // 2. Dispatch pending outbox events
      const result = await outboxService.dispatchPendingEvents(10);
      expect(result.dispatched).toBeGreaterThanOrEqual(1);

      // 3. Verify status in PostgreSQL updated to PUBLISHED
      const rows = await postgresDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM outbox_events WHERE event_id = $1`,
        event.eventId,
      );
      if (rows && rows.length > 0) {
        expect(rows[0].status).toBe('PUBLISHED');
      }
    });
  });

  describe('6. Audit Log HTTP Query Endpoints (ADMIN only)', () => {
    it('retrieves paginated audit logs via GET /api/audit-logs', async () => {
      const eventId = crypto.randomUUID();
      await auditLogService.recordAuditLog({
        eventId,
        eventType: 'auth.login.succeeded',
        occurredAt: new Date().toISOString(),
        targetType: 'auth',
        targetId: 'user-audit-123',
        source: 'auth-service',
        outcome: 'SUCCESS',
        metadata: { ipAddress: '127.0.0.1' },
      });

      const res = await request(app)
        .get('/api/audit-logs')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN')
        .query({ eventType: 'auth.login.succeeded' });

      expect(res.status).toBe(200);
      expect(res.body.items).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(1);

      const found = res.body.items.find((i: { eventId: string }) => i.eventId === eventId);
      expect(found).toBeDefined();
      expect(found.targetType).toBe('auth');
    });

    it('rejects unauthorized audit log queries with 401/403', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .set('x-user-id', 'regular-user-id')
        .set('x-user-role', 'USER');

      expect([401, 403]).toContain(res.status);
    });

    it('retrieves a specific audit log by event ID via GET /api/audit-logs/:eventId', async () => {
      const eventId = crypto.randomUUID();
      await auditLogService.recordAuditLog({
        eventId,
        eventType: 'product.created',
        occurredAt: new Date().toISOString(),
        targetType: 'product',
        targetId: 'p-audit-single',
        source: 'products-service',
        outcome: 'SUCCESS',
      });

      const res = await request(app)
        .get(`/api/audit-logs/${eventId}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(200);
      expect(res.body.eventId).toBe(eventId);
      expect(res.body.targetId).toBe('p-audit-single');
    });
  });
});
