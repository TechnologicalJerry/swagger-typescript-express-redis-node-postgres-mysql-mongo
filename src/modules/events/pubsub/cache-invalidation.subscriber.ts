import { EventPubSubSubscriber, eventPubSubSubscriber } from './pubsub-subscriber.service.js';
import { ProductCacheService, productCacheService } from '../../products/product-cache.service.js';
import { PubSubChannel, type DomainEvent } from '../event.types.js';
import { logger } from '../../../config/logger.js';

export class CacheInvalidationSubscriber {
  private readonly subscriber: EventPubSubSubscriber;
  private readonly productCache: ProductCacheService;

  constructor(
    subscriber: EventPubSubSubscriber = eventPubSubSubscriber,
    productCache: ProductCacheService = productCacheService,
  ) {
    this.subscriber = subscriber;
    this.productCache = productCache;
  }

  /**
   * Processes product catalog events received via Pub/Sub to invalidate local/Redis cache entries.
   */
  private handleProductEvent = async (event: DomainEvent): Promise<void> => {
    if (event.eventType === 'product.updated' || event.eventType === 'product.deleted') {
      const payload = event.payload as { productId?: string };
      const productId = payload.productId;

      if (productId) {
        logger.info(
          { eventId: event.eventId, eventType: event.eventType, productId },
          'Received Pub/Sub cache invalidation notification',
        );

        try {
          await this.productCache.invalidateProduct(productId);
          await this.productCache.invalidateAllLists();
        } catch (err: unknown) {
          logger.warn(
            { err, productId },
            'Failed to execute cache invalidation triggered by Pub/Sub event',
          );
        }
      }
    }
  };

  /**
   * Initializes the cache invalidation subscriber on the products channel.
   */
  public async start(): Promise<void> {
    await this.subscriber.subscribe(PubSubChannel.PRODUCTS, this.handleProductEvent);
    await this.subscriber.start();
    logger.info('Cache invalidation Pub/Sub listener registered on events:products');
  }

  /**
   * Unregisters the cache invalidation listener.
   */
  public async stop(): Promise<void> {
    await this.subscriber.unsubscribe(PubSubChannel.PRODUCTS, this.handleProductEvent);
    await this.subscriber.stop();
  }
}

export const cacheInvalidationSubscriber = new CacheInvalidationSubscriber();
