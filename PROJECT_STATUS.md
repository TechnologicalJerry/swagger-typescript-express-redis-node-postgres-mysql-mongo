# Project Status: Redis Learning Backend

## Current Phase: Phase 9 — Redis Pub/Sub, Redis Streams, and MongoDB Audit Logs

**Status:** Implementation Complete (Source code, types, configuration, migration SQL, documentation, and test files written).  
**Execution Status:** **NOT EXECUTED OR VERIFIED**. Per workflow instructions, no runtime commands, builds, database migrations, tests, or container inspections have been executed. Application execution and complete testing will occur after all 10 phases are implemented.

---

## 1. Implemented Tasks (Phase 9)

1. **MongoDB Audit Log Model & Deduplication (`src/db/mongo/models/audit-log.model.ts` & `src/modules/audit/`)**:
   - Created Mongoose `AuditLog` model in collection `audit_logs`:
     - `eventId`: UUIDv4 unique string (`unique: true, index: true`).
     - `eventType`: Namespaced string (`index: true`).
     - `eventVersion`: Positive integer schema version (default `1`).
     - `occurredAt` & `recordedAt`: Indexed timestamps.
     - `actorId`: Optional user identifier (`index: true`).
     - `targetType` & `targetId`: Resource identifiers (`index: true`).
     - `correlationId`: Tracing identifier (`index: true`).
     - `source`: Producer service name.
     - `outcome`: Enum (`SUCCESS` | `FAILURE`).
     - `metadata`: Schema.Types.Mixed with recursive secret sanitization.
   - Compound indexes: `{ eventType: 1, occurredAt: -1 }`, `{ targetType: 1, targetId: 1, occurredAt: -1 }`, `{ actorId: 1, occurredAt: -1 }`.
   - `AuditLogService` (`src/modules/audit/audit.service.ts`):
     - Catches MongoDB `11000` duplicate key errors on `eventId` as idempotent successes without throwing.
     - Paginated query service with filtering for administrator review.

2. **Domain Event Contracts & Secret Sanitization (`src/modules/events/`)**:
   - `src/modules/events/event.types.ts`: Standardized `DomainEvent<T>` envelope contract and specific payload types for products, inventory, reservations, and authentication.
   - `src/modules/events/event.schema.ts`: Zod schema validation for envelope and payloads.
   - Recursive sanitization helper `sanitizeEventPayload`: Redacts passwords, hashes, JWT tokens, refresh tokens, OTPs, and lock owner tokens before publishing or persistence.

3. **Redis Pub/Sub: Transient Real-Time Notifications (`src/modules/events/pubsub/`)**:
   - Channels: `events:products`, `events:inventory`, `events:reservations`, `events:auth`.
   - `EventPubSubPublisher`: Publishes validated domain events using the canonical Redis `PUBLISH` command (fire-and-forget, at-most-once delivery).
   - `EventPubSubSubscriber`: Manages a **dedicated** Redis client connection required by ioredis subscriber mode, dispatches messages to registered handlers, safely isolates errors, and prevents process crashes on malformed input.
   - `CacheInvalidationSubscriber`: Listens on `events:products` for `product.updated` and `product.deleted` events and purges Redis product caches in real time.

4. **Redis Streams: Durable Log & Consumer Groups (`src/modules/events/streams/`)**:
   - Key conventions: `stream:domain-events` (primary log) and `stream:dead-letter:domain-events` (dead-letter queue).
   - `EventStreamProducer`: Appends events using `XADD` with approximate trimming (`MAXLEN ~ 10000`) and automatic millisecond entry ID assignment.
   - `AuditLogStreamConsumer`:
     - Creates consumer group `audit-log-workers` with `XGROUP CREATE ... $ MKSTREAM` (safely handling `BUSYGROUP`).
     - Reads batches via `XREADGROUP` with blocking timeout (`BLOCK 2000`).
     - Converts stream entries to audit log documents and persists them into MongoDB.
     - Acknowledges successfully processed entries using `XACK`.
     - Recovers pending abandoned entries using `XPENDING` and `XCLAIM`.
     - Routes repeatedly failing entries (exceeding `maxRetries = 3`) to the dead-letter stream with sanitized error reasons before `XACK`ing the primary stream.

5. **PostgreSQL Transactional Outbox Pattern (`src/modules/events/outbox/`)**:
   - Updated `prisma/postgres/schema.prisma` with `OutboxStatus` enum and `OutboxEvent` model (`outbox_events` table).
   - Authored unapplied migration SQL `prisma/postgres/migrations/20261015170000_create_outbox_events/migration.sql` (**not applied** per instructions).
   - `OutboxService`: Records outbox events inside PostgreSQL transactions atomically alongside business mutations.
   - `OutboxScheduler`: Periodically scans pending outbox events, dispatches them to Redis Pub/Sub and Redis Streams, and updates status to `PUBLISHED`.

6. **Unified Event Publisher & Business Module Integration**:
   - Created `EventPublisherService` coordinating both Pub/Sub and Streams.
   - Integrated domain event publishing into:
     - `ProductService`: `product.created`, `product.updated`, `product.deleted`.
     - `ReservationService`: `reservation.created`, `reservation.confirmed`, `reservation.cancelled`, `reservation.expired` (via transactional outbox + post-commit fast path).
     - `AuthService`: `auth.login.succeeded`, `auth.login.failed`.

7. **Audit Log HTTP Endpoints & Routes (`src/modules/audit/`)**:
   - Endpoints mounted at `/api/audit-logs`:
     - `GET /api/audit-logs`: Paginated audit log search (ADMIN only).
     - `GET /api/audit-logs/:eventId`: Audit log retrieval by event ID (ADMIN only).
   - Mounted in `src/app.ts`.

8. **Application Lifecycle Integration (`src/server.ts`)**:
   - Starts `cacheInvalidationSubscriber`, `auditLogStreamConsumer`, and `outboxScheduler` on server startup.
   - Stops stream consumer, pub/sub subscriber, and outbox scheduler gracefully on shutdown.

9. **Environment Configuration**:
   - Updated `src/config/env.ts`, `.env`, `.env.example`, and `tests/env.test.ts` with validated configuration for stream keys, consumer groups, worker names, batch sizes, block timeouts, retry limits, claim idle times, and outbox polling intervals.

10. **Automated Test Suite (Write-Only)**:
    - `tests/events.test.ts`: Complete Vitest suite covering:
      - Event contracts, envelope validation, and recursive secret sanitization.
      - Redis Pub/Sub publishing, dedicated subscriber handling, malformed message rejection, and disconnected subscriber message loss.
      - Redis Streams `XADD` entry creation, consumer group processing, `XACK`, poison message dead-letter routing, and pending recovery via `XCLAIM`.
      - MongoDB audit log schema validation and idempotent duplicate key handling on `eventId`.
      - PostgreSQL transactional outbox recording and dispatch.
      - Audit log HTTP query endpoints with ADMIN role enforcement.

---

## 2. Files Created or Modified (Phase 9)

### Created:
- `prisma/postgres/migrations/20261015170000_create_outbox_events/migration.sql` — Unapplied PostgreSQL migration for transactional outbox table.
- `src/db/mongo/models/audit-log.model.ts` — Mongoose audit log model and schema.
- `src/modules/audit/audit.types.ts` — Audit log domain interfaces, query filters, and records.
- `src/modules/audit/audit.schema.ts` — Zod query validation schemas.
- `src/modules/audit/audit.service.ts` — MongoDB audit log service with idempotent deduplication and sanitization.
- `src/modules/audit/audit.controller.ts` — Express controller for audit log queries.
- `src/modules/audit/audit.routes.ts` — Express router with ADMIN authorization guards.
- `src/modules/events/event.types.ts` — Domain event contracts, payload types, and channel enums.
- `src/modules/events/event.schema.ts` — Zod event envelope validation and secret sanitization helper.
- `src/modules/events/pubsub/pubsub-publisher.service.ts` — Redis Pub/Sub publisher service.
- `src/modules/events/pubsub/pubsub-subscriber.service.ts` — Dedicated Redis Pub/Sub subscriber service.
- `src/modules/events/pubsub/cache-invalidation.subscriber.ts` — Real-time product cache invalidation subscriber.
- `src/modules/events/streams/stream-producer.service.ts` — Redis Stream producer with `XADD` and approximate trimming.
- `src/modules/events/streams/stream-consumer.service.ts` — Redis Stream consumer with consumer groups, `XACK`, dead-lettering, and pending recovery.
- `src/modules/events/outbox/outbox.service.ts` — PostgreSQL transactional outbox service.
- `src/modules/events/outbox/outbox.scheduler.ts` — Periodic outbox dispatcher scheduler.
- `src/modules/events/event-publisher.service.ts` — Unified event publisher service coordinating Pub/Sub and Streams.
- `tests/events.test.ts` — Automated Vitest test suite for Phase 9.

### Modified:
- `prisma/postgres/schema.prisma` — Added `OutboxStatus` enum and `OutboxEvent` model.
- `src/config/env.ts` — Added validated configuration for Redis Streams and Outbox.
- `.env` — Added Phase 9 environment variables.
- `.env.example` — Documented Phase 9 environment variables.
- `tests/env.test.ts` — Added assertions for Phase 9 configuration.
- `src/app.ts` — Mounted `auditRoutes` at `/api/audit-logs`.
- `src/server.ts` — Wired stream consumer, pub/sub subscriber, and outbox scheduler into server lifecycle.
- `src/modules/products/products.service.ts` — Integrated domain event publishing for product create/update/delete.
- `src/modules/inventory/reservation.service.ts` — Integrated transactional outbox recording and event publishing for reservations.
- `src/modules/auth/auth.service.ts` — Integrated domain event publishing for login success/failure.
- `README.md` — Documented Phase 9 features, Pub/Sub vs. Streams comparison, consumer groups, dead-letter policy, MongoDB audit log schema, outbox pattern, and Redis key inventory.
- `PROJECT_STATUS.md` — Updated status to reflect Phase 9 implementation.

---

## 3. Redis Key Patterns Introduced in Phase 9

| Pattern | Redis Data Type | TTL Policy | Cleanup Behavior |
| :--- | :--- | :--- | :--- |
| `events:products` | Pub/Sub Channel | N/A (in-memory bus) | Ephemeral broadcast; no storage |
| `events:inventory` | Pub/Sub Channel | N/A (in-memory bus) | Ephemeral broadcast; no storage |
| `events:reservations` | Pub/Sub Channel | N/A (in-memory bus) | Ephemeral broadcast; no storage |
| `events:auth` | Pub/Sub Channel | N/A (in-memory bus) | Ephemeral broadcast; no storage |
| `stream:domain-events` | Stream | Approximate trimming (`MAXLEN ~ 10000`) | Maintained by consumer groups and trimming policy |
| `stream:dead-letter:domain-events` | Stream | None (permanent audit retention) | Maintained for administrative inspection of failed entries |

---

## 4. Known Consistency Limitations & Decisions

1. **Pub/Sub At-Most-Once Delivery**:
   - Redis Pub/Sub messages are fire-and-forget. If a subscriber process is disconnected, restarting, or slow, messages are dropped. Pub/Sub is strictly used for non-critical, transient operations (e.g. cache invalidation hints).
2. **Streams At-Least-Once Delivery**:
   - Redis Streams guarantee message retention and consumer group tracking, but delivery is at-least-once. Network retries, worker crashes, or unacknowledged claims can redeliver messages. Downstream consumers (such as `AuditLogService`) enforce application-level idempotency via MongoDB unique indexes on `eventId`.
3. **Cross-Database 2PC Limitation & Transactional Outbox**:
   - No distributed two-phase commit exists between PostgreSQL/MySQL, Redis, and MongoDB.
   - For critical reservation operations, PostgreSQL transactions persist an `outbox_events` record atomically in the same database transaction as the business change. If Redis publishing fails post-commit, the `OutboxScheduler` eventually dispatches the event once Redis is healthy.
4. **Prisma 7 Client Generation Deferred**:
   - In accordance with the write-only workflow, `prisma generate` and `prisma migrate deploy` are deferred to post-Phase 10. Database queries on `outbox_events` use parameterized `$queryRawUnsafe` within transactions.

---

## 5. Execution & Verification Status

- **Status:** **NOT EXECUTED OR VERIFIED**.
- No terminal commands, tests, builds, Prisma migrations, Docker executions, or Redis inspections were performed in this phase, complying with the write-only workflow requirement.
- Full runtime verification will be performed across the entire test suite after all 10 phases are completed.

---

## 6. Remaining Phases

- **Phase 10**: Background Processing & Delayed Jobs with BullMQ
