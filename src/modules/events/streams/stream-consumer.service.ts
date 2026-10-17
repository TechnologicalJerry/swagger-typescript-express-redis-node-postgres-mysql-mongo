import type { Redis } from 'ioredis';
import { redis } from '../../../db/redis/client.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { AuditLogService, auditLogService } from '../../audit/audit.service.js';

function parseStreamFields(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    result[fields[i]] = fields[i + 1];
  }
  return result;
}

function deriveTargetInfo(eventType: string, payload: Record<string, unknown>): { targetType: string; targetId: string } {
  const [prefix] = eventType.split('.');
  let targetId = 'unknown';

  if (payload.productId) targetId = String(payload.productId);
  else if (payload.reservationId) targetId = String(payload.reservationId);
  else if (payload.userId) targetId = String(payload.userId);
  else if (payload.id) targetId = String(payload.id);

  return {
    targetType: prefix || 'domain',
    targetId,
  };
}

export class AuditLogStreamConsumer {
  private readonly redis: Redis;
  private readonly auditService: AuditLogService;
  public readonly streamKey: string;
  public readonly deadLetterStreamKey: string;
  public readonly groupName: string;
  public readonly consumerName: string;
  public readonly batchSize: number;
  public readonly blockMs: number;
  public readonly maxRetries: number;
  public readonly claimMinIdleMs: number;

  private isRunning = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    redisInstance: Redis = redis,
    auditService: AuditLogService = auditLogService,
    streamKey: string = env.REDIS_STREAM_DOMAIN_EVENTS,
    deadLetterStreamKey: string = env.REDIS_STREAM_DEAD_LETTER,
    groupName: string = env.REDIS_STREAM_CONSUMER_GROUP,
    consumerName: string = env.REDIS_STREAM_CONSUMER_NAME,
    batchSize: number = env.REDIS_STREAM_BATCH_SIZE,
    blockMs: number = env.REDIS_STREAM_BLOCK_MS,
    maxRetries: number = env.REDIS_STREAM_MAX_RETRIES,
    claimMinIdleMs: number = env.REDIS_STREAM_CLAIM_MIN_IDLE_MS,
  ) {
    this.redis = redisInstance;
    this.auditService = auditService;
    this.streamKey = streamKey;
    this.deadLetterStreamKey = deadLetterStreamKey;
    this.groupName = groupName;
    this.consumerName = consumerName;
    this.batchSize = batchSize;
    this.blockMs = blockMs;
    this.maxRetries = maxRetries;
    this.claimMinIdleMs = claimMinIdleMs;
  }

  /**
   * Initializes the Redis Consumer Group using XGROUP CREATE with MKSTREAM.
   *
   * Redis command:
   *   XGROUP CREATE <streamKey> <groupName> $ MKSTREAM
   *
   * Safely catches BUSYGROUP if the group already exists without failing.
   */
  public async initGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.streamKey, this.groupName, '$', 'MKSTREAM');
      logger.info(
        { streamKey: this.streamKey, groupName: this.groupName },
        'Created Redis Stream consumer group',
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('BUSYGROUP')) {
        logger.debug(
          { streamKey: this.streamKey, groupName: this.groupName },
          'Consumer group already exists; continuing',
        );
      } else {
        logger.error({ err, streamKey: this.streamKey, groupName: this.groupName }, 'Error creating consumer group');
        throw err;
      }
    }
  }

  /**
   * Processes a single stream entry, records the MongoDB audit log, and acknowledges the entry via XACK.
   */
  public async processEntry(entryId: string, fields: string[]): Promise<boolean> {
    const raw = parseStreamFields(fields);
    const eventId = raw.eventId;
    const eventType = raw.eventType;

    if (!eventId || !eventType) {
      logger.warn({ entryId, raw }, 'Encountered malformed stream entry lacking eventId or eventType; dead-lettering');
      await this.routeToDeadLetter(entryId, raw, 'Missing required eventId or eventType');
      await this.redis.xack(this.streamKey, this.groupName, entryId);
      return false;
    }

    let payload: Record<string, unknown> = {};
    if (raw.payload) {
      try {
        payload = JSON.parse(raw.payload) as Record<string, unknown>;
      } catch {
        payload = { rawPayload: raw.payload };
      }
    }

    const { targetType, targetId } = deriveTargetInfo(eventType, payload);
    const actorId = payload.userId ? String(payload.userId) : (payload.actorId ? String(payload.actorId) : null);
    const isFailure = eventType.includes('failed') || raw.outcome === 'FAILURE';

    try {
      // Idempotent audit record persistence
      await this.auditService.recordAuditLog({
        eventId,
        eventType,
        eventVersion: raw.eventVersion ? Number(raw.eventVersion) : 1,
        occurredAt: raw.occurredAt || new Date().toISOString(),
        actorId,
        targetType,
        targetId,
        correlationId: raw.correlationId || null,
        source: raw.producer || 'stream-consumer',
        outcome: isFailure ? 'FAILURE' : 'SUCCESS',
        metadata: payload,
      });

      // Acknowledge successfully processed message
      // XACK streamKey groupName entryId
      await this.redis.xack(this.streamKey, this.groupName, entryId);

      logger.debug(
        { entryId, eventId, eventType, groupName: this.groupName },
        'Processed and acknowledged stream entry in MongoDB audit log',
      );

      return true;
    } catch (err: unknown) {
      logger.error(
        { err, entryId, eventId, eventType },
        'Failed to process stream entry; retaining in pending list for retry',
      );
      return false;
    }
  }

  /**
   * Routes a repeatedly failing or poison message to the dead-letter stream.
   */
  public async routeToDeadLetter(
    entryId: string,
    rawEntry: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    try {
      await this.redis.xadd(
        this.deadLetterStreamKey,
        '*',
        'eventId',
        String(rawEntry.eventId || ''),
        'originalStream',
        this.streamKey,
        'originalEntryId',
        entryId,
        'reason',
        reason,
        'consumer',
        this.consumerName,
        'deadLetteredAt',
        new Date().toISOString(),
        'rawEntry',
        JSON.stringify(rawEntry),
      );

      logger.warn(
        { entryId, deadLetterStream: this.deadLetterStreamKey, reason },
        'Moved unprocessable entry to dead-letter stream',
      );
    } catch (err: unknown) {
      logger.error({ err, entryId }, 'Failed to write entry to dead-letter stream');
    }
  }

  /**
   * Recovers pending messages that were unacknowledged by crashed or delayed consumers.
   *
   * Redis commands:
   *   XPENDING <streamKey> <groupName> - + <limit>
   *   XCLAIM <streamKey> <groupName> <consumer> <minIdleTimeMs> <entryId>
   */
  public async recoverPendingMessages(limit: number = 20): Promise<number> {
    try {
      // XPENDING streamKey groupName - + limit
      const pendingRaw = (await this.redis.xpending(
        this.streamKey,
        this.groupName,
        '-',
        '+',
        limit,
      )) as Array<[entryId: string, consumer: string, idleTimeMs: number, deliveryCount: number]>;

      if (!pendingRaw || pendingRaw.length === 0) {
        return 0;
      }

      let recoveredCount = 0;

      for (const [entryId, , idleTimeMs, deliveryCount] of pendingRaw) {
        if (idleTimeMs >= this.claimMinIdleMs) {
          // If exceeded max retry threshold, route to dead-letter stream and acknowledge
          if (deliveryCount >= this.maxRetries) {
            logger.warn(
              { entryId, deliveryCount, maxRetries: this.maxRetries },
              'Pending entry exceeded max retry limit; moving to dead-letter stream',
            );

            // Fetch entry data before dead-lettering
            const claimed = (await this.redis.xclaim(
              this.streamKey,
              this.groupName,
              this.consumerName,
              this.claimMinIdleMs,
              entryId,
            )) as Array<[string, string[]]>;

            if (claimed && claimed.length > 0) {
              const fields = claimed[0][1];
              await this.routeToDeadLetter(entryId, parseStreamFields(fields), `Exceeded max retries (${deliveryCount})`);
            }

            await this.redis.xack(this.streamKey, this.groupName, entryId);
            continue;
          }

          // Otherwise claim the entry for reprocessing
          // XCLAIM streamKey groupName consumer minIdleTimeMs entryId
          const claimed = (await this.redis.xclaim(
            this.streamKey,
            this.groupName,
            this.consumerName,
            this.claimMinIdleMs,
            entryId,
          )) as Array<[string, string[]]>;

          if (claimed && claimed.length > 0) {
            const [claimedId, fields] = claimed[0];
            const processed = await this.processEntry(claimedId, fields);
            if (processed) recoveredCount++;
          }
        }
      }

      return recoveredCount;
    } catch (err: unknown) {
      logger.warn({ err }, 'Error checking or claiming pending stream messages');
      return 0;
    }
  }

  /**
   * Main consumption loop using blocking XREADGROUP.
   */
  private async runLoop(): Promise<void> {
    logger.info(
      { streamKey: this.streamKey, groupName: this.groupName, consumerName: this.consumerName },
      'Started Redis Stream audit consumer loop',
    );

    let tickCount = 0;

    while (this.isRunning) {
      try {
        tickCount++;

        // Periodically run pending message recovery (every 10 ticks)
        if (tickCount % 10 === 0) {
          await this.recoverPendingMessages();
        }

        // XREADGROUP GROUP groupName consumerName COUNT batchSize BLOCK blockMs STREAMS streamKey >
        const response = (await this.redis.xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.streamKey,
          '>',
        )) as Array<[streamKey: string, entries: Array<[entryId: string, fields: string[]]>]> | null;

        if (!response || response.length === 0) {
          continue;
        }

        const [, entries] = response[0];
        if (!entries || entries.length === 0) {
          continue;
        }

        for (const [entryId, fields] of entries) {
          if (!this.isRunning) break;
          await this.processEntry(entryId, fields);
        }
      } catch (err: unknown) {
        if (!this.isRunning) break;
        logger.error({ err }, 'Error in Redis Stream audit consumer loop; sleeping 1000ms');
        await new Promise((res) => setTimeout(res, 1000));
      }
    }

    logger.info('Exited Redis Stream audit consumer loop');
  }

  /**
   * Starts the stream consumer group and consumption loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;

    await this.initGroup();
    this.isRunning = true;
    this.loopPromise = this.runLoop();
  }

  /**
   * Gracefully stops the stream consumer without acknowledging incomplete messages.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping Redis Stream audit consumer');
    this.isRunning = false;

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }
}

export const auditLogStreamConsumer = new AuditLogStreamConsumer();
