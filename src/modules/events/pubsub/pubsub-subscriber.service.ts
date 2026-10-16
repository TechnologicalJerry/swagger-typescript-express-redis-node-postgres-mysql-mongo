import { Redis } from 'ioredis';
import { env } from '../../../config/env.js';
import { logger, redactConnectionString } from '../../../config/logger.js';
import { domainEventEnvelopeSchema } from '../event.schema.js';
import type { DomainEvent, EventHandler } from '../event.types.js';

export class EventPubSubSubscriber {
  private subscriberClient: Redis | null = null;
  private readonly handlers: Map<string, Set<EventHandler>> = new Map();
  private isListening = false;

  constructor() {}

  /**
   * Lazily creates a dedicated Redis connection for Pub/Sub subscriptions.
   *
   * Note on Redis Protocol:
   * Once a Redis client enters subscriber mode (via SUBSCRIBE/PSUBSCRIBE), it can only
   * issue Pub/Sub-related commands (SUBSCRIBE, UNSUBSCRIBE, PING, QUIT).
   * It cannot execute regular commands (GET, SET, XADD, etc.). Therefore, a dedicated
   * connection is strictly required to avoid breaking normal application commands.
   */
  private getOrCreateSubscriberClient(): Redis {
    if (!this.subscriberClient) {
      const redactedEndpoint = redactConnectionString(env.REDIS_URL);
      this.subscriberClient = new Redis(env.REDIS_URL, {
        connectTimeout: 5000,
        enableReadyCheck: true,
        lazyConnect: true,
        maxRetriesPerRequest: null, // Required by ioredis for subscriber mode
      });

      this.subscriberClient.on('connect', () => {
        logger.info({ endpoint: redactedEndpoint }, 'Dedicated Redis Pub/Sub subscriber connected');
      });

      this.subscriberClient.on('error', (err: Error) => {
        logger.error({ endpoint: redactedEndpoint, message: err.message }, 'Redis subscriber connection error');
      });

      this.subscriberClient.on('message', (channel: string, message: string) => {
        this.handleIncomingMessage(channel, message);
      });
    }

    return this.subscriberClient;
  }

  /**
   * Dispatches incoming raw channel messages safely to registered handlers.
   * Safely catches JSON parse and schema validation errors without crashing the process.
   */
  private async handleIncomingMessage(channel: string, rawMessage: string): Promise<void> {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers || channelHandlers.size === 0) {
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawMessage);
    } catch (parseErr) {
      logger.warn(
        { parseErr, channel, messageLength: rawMessage.length },
        'Received malformed non-JSON message on Pub/Sub channel; safely discarding',
      );
      return;
    }

    const validationResult = domainEventEnvelopeSchema.safeParse(parsedJson);
    if (!validationResult.success) {
      logger.warn(
        { issues: validationResult.error.issues, channel },
        'Received event violating envelope schema on Pub/Sub channel; safely discarding',
      );
      return;
    }

    const event = validationResult.data as DomainEvent;

    // Dispatch to registered handlers concurrently
    for (const handler of channelHandlers) {
      try {
        await handler(event);
      } catch (err: unknown) {
        logger.error(
          {
            err,
            channel,
            eventId: event.eventId,
            eventType: event.eventType,
          },
          'Error executing Pub/Sub event handler',
        );
      }
    }
  }

  /**
   * Registers a handler for a specific Pub/Sub channel.
   * Automatically issues SUBSCRIBE to Redis if already listening.
   */
  public async subscribe(channel: string, handler: EventHandler): Promise<void> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }

    const channelSet = this.handlers.get(channel)!;
    channelSet.add(handler);

    // If client is already running, subscribe to the channel immediately
    if (this.isListening && this.subscriberClient) {
      await this.subscriberClient.subscribe(channel);
      logger.debug({ channel }, 'Subscribed to Redis Pub/Sub channel');
    }
  }

  /**
   * Unregisters a handler from a Pub/Sub channel.
   */
  public async unsubscribe(channel: string, handler?: EventHandler): Promise<void> {
    const channelSet = this.handlers.get(channel);
    if (!channelSet) return;

    if (handler) {
      channelSet.delete(handler);
    } else {
      channelSet.clear();
    }

    // If no handlers remain for this channel, tell Redis to unsubscribe
    if (channelSet.size === 0) {
      this.handlers.delete(channel);
      if (this.subscriberClient && this.isListening) {
        await this.subscriberClient.unsubscribe(channel);
        logger.debug({ channel }, 'Unsubscribed from Redis Pub/Sub channel');
      }
    }
  }

  /**
   * Starts the subscriber and attaches to all registered channels.
   */
  public async start(): Promise<void> {
    if (this.isListening) return;

    const client = this.getOrCreateSubscriberClient();
    if (client.status === 'wait') {
      await client.connect();
    }

    this.isListening = true;

    const channels = Array.from(this.handlers.keys());
    if (channels.length > 0) {
      await client.subscribe(...channels);
      logger.info({ channels }, 'Redis Pub/Sub subscriber started and listening to channels');
    } else {
      logger.info('Redis Pub/Sub subscriber started (no active channels registered yet)');
    }
  }

  /**
   * Gracefully shuts down the dedicated subscriber connection.
   */
  public async stop(): Promise<void> {
    if (!this.isListening || !this.subscriberClient) return;

    this.isListening = false;
    logger.info('Stopping Redis Pub/Sub subscriber');

    try {
      if (this.subscriberClient.status !== 'end') {
        await this.subscriberClient.quit();
      }
    } catch {
      this.subscriberClient.disconnect();
    } finally {
      this.subscriberClient = null;
    }
  }
}

export const eventPubSubSubscriber = new EventPubSubSubscriber();
