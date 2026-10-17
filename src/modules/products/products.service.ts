import { ProductRepository, productRepository } from './products.repository.js';
import { ProductCacheService, productCacheService } from './product-cache.service.js';
import { ProductCacheLockService, productCacheLockService } from './product-cache-lock.service.js';
import { TrendingService, trendingService } from './trending.service.js';
import { ProductAnalyticsService, productAnalyticsService } from './product-analytics.service.js';
import { eventPublisherService, EventPublisherService } from '../events/event-publisher.service.js';
import { PubSubChannel } from '../events/event.types.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../config/logger.js';
import type {
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryFilters,
  PaginatedProductsResult,
  CacheState,
  TrendingResponse,
  TrendingProduct,
  ProductAnalyticsResponse,
} from './products.types.js';

export class ProductService {
  private readonly repo: ProductRepository;
  private readonly cache: ProductCacheService;
  private readonly cacheLock: ProductCacheLockService;
  private readonly trending: TrendingService;
  private readonly analytics: ProductAnalyticsService;
  private readonly eventPublisher: EventPublisherService;

  constructor(
    repo: ProductRepository = productRepository,
    cache: ProductCacheService = productCacheService,
    cacheLock: ProductCacheLockService = productCacheLockService,
    trending: TrendingService = trendingService,
    analytics: ProductAnalyticsService = productAnalyticsService,
    eventPublisher: EventPublisherService = eventPublisherService,
  ) {
    this.repo = repo;
    this.cache = cache;
    this.cacheLock = cacheLock;
    this.trending = trending;
    this.analytics = analytics;
    this.eventPublisher = eventPublisher;
  }

  /**
   * Generates a URL-friendly slug from product name if none is provided.
   */
  public generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  /**
   * Creates a product in MySQL (source of truth) and invalidates affected list caches.
   */
  public async createProduct(input: CreateProductInput): Promise<Product> {
    const slug = input.slug || this.generateSlug(input.name);

    // Verify uniqueness of SKU
    const existingSku = await this.repo.findBySku(input.sku);
    if (existingSku) {
      throw new HttpError(409, 'Product with this SKU already exists');
    }

    // Verify uniqueness of slug
    const existingSlug = await this.repo.findBySlug(slug);
    if (existingSlug) {
      throw new HttpError(409, 'Product with this slug already exists');
    }

    // 1. Persist to MySQL source of truth
    const product = await this.repo.create({
      ...input,
      slug,
    });

    // 2. Invalidate product list caches
    try {
      await this.cache.invalidateAllLists();
    } catch (cacheErr) {
      logger.error({ cacheErr, productId: product.id }, 'Warning: Failed to invalidate list caches after product creation');
    }

    // 3. Publish product.created domain event to Pub/Sub and Streams
    try {
      const event = this.eventPublisher.createEvent(
        'product.created',
        'products-service',
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          price: Number(product.price),
          category: product.category,
        },
      );
      await this.eventPublisher.publishDomainEvent(PubSubChannel.PRODUCTS, event);
    } catch (eventErr) {
      logger.warn({ eventErr, productId: product.id }, 'Warning: Failed to publish product.created event');
    }

    return product;
  }

  /**
   * Retrieves an individual product using Redis Cache-Aside and Cache-Stampede Protection.
   */
  public async getProductById(
    id: string,
    options?: { bypassCache?: boolean },
  ): Promise<{ product: Product; cacheState: CacheState }> {
    // Deliberate client bypass or Redis unavailable
    if (options?.bypassCache || !this.cache.isAvailable()) {
      const product = await this.repo.findById(id);
      if (!product) {
        throw new HttpError(404, 'Product not found');
      }
      return { product, cacheState: 'BYPASS' };
    }

    // 1. Cache-Aside: Check Redis cache first
    const cached = await this.cache.getProduct(id);
    if (cached) {
      return { product: cached, cacheState: 'HIT' };
    }

    // 2. Cache Miss: Coordinate concurrent stampede via distributed lock
    const lockToken = await this.cacheLock.acquireLock(id);

    if (lockToken) {
      try {
        // Lock acquired: Winner queries MySQL and repopulates Redis cache
        const product = await this.repo.findById(id);
        if (!product) {
          throw new HttpError(404, 'Product not found');
        }

        await this.cache.setProduct(product);
        return { product, cacheState: 'MISS' };
      } finally {
        // Always release lock safely with Lua compare-and-delete
        await this.cacheLock.releaseLock(id, lockToken);
      }
    }

    // 3. Lock not acquired: another concurrent request is repopulating the cache.
    // Wait briefly (up to 3 retries, 50ms interval) to read the populated cache
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retryCached = await this.cache.getProduct(id);
      if (retryCached) {
        return { product: retryCached, cacheState: 'HIT' };
      }
    }

    // 4. Fallback if lock holder was slow or encountered an issue
    const fallback = await this.repo.findById(id);
    if (!fallback) {
      throw new HttpError(404, 'Product not found');
    }

    return { product: fallback, cacheState: 'MISS' };
  }

  /**
   * Retrieves a paginated list of products using query-fingerprinted caching.
   */
  public async listProducts(
    filters: ProductQueryFilters,
    options?: { bypassCache?: boolean },
  ): Promise<{ result: PaginatedProductsResult; cacheState: CacheState }> {
    const page = filters.page || 1;
    const limit = filters.limit || 10;

    // Check deliberate bypass or Redis offline
    if (options?.bypassCache || !this.cache.isAvailable()) {
      const { products, total } = await this.repo.findMany(filters);
      const totalPages = Math.ceil(total / limit);

      const result: PaginatedProductsResult = {
        data: products,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      };

      return { result, cacheState: 'BYPASS' };
    }

    const fingerprint = this.cache.getQueryFingerprint(filters);

    // 1. Check list cache
    const cachedList = await this.cache.getList(fingerprint);
    if (cachedList) {
      return { result: cachedList, cacheState: 'HIT' };
    }

    // 2. Query MySQL
    const { products, total } = await this.repo.findMany(filters);
    const totalPages = Math.ceil(total / limit);

    const result: PaginatedProductsResult = {
      data: products,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };

    // 3. Cache the list result with short TTL
    await this.cache.setList(fingerprint, result);

    return { result, cacheState: 'MISS' };
  }

  /**
   * Updates product in MySQL and invalidates Redis individual and list caches.
   */
  public async updateProduct(id: string, input: UpdateProductInput): Promise<Product> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw new HttpError(404, 'Product not found');
    }

    if (input.sku && input.sku !== existing.sku) {
      const duplicateSku = await this.repo.findBySku(input.sku);
      if (duplicateSku && duplicateSku.id !== id) {
        throw new HttpError(409, 'Product with this SKU already exists');
      }
    }

    if (input.slug && input.slug !== existing.slug) {
      const duplicateSlug = await this.repo.findBySlug(input.slug);
      if (duplicateSlug && duplicateSlug.id !== id) {
        throw new HttpError(409, 'Product with this slug already exists');
      }
    }

    // 1. MySQL updated first (source of truth)
    const updated = await this.repo.update(id, input);

    // 2. Invalidate cache after database success
    try {
      await this.cache.invalidateProduct(id);
    } catch (cacheErr) {
      logger.error({ cacheErr, productId: id }, 'Warning: Cache invalidation failed after product update');
    }

    // 3. Publish product.updated domain event to Pub/Sub and Streams
    try {
      const event = this.eventPublisher.createEvent(
        'product.updated',
        'products-service',
        {
          productId: updated.id,
          updatedFields: Object.keys(input),
        },
      );
      await this.eventPublisher.publishDomainEvent(PubSubChannel.PRODUCTS, event);
    } catch (eventErr) {
      logger.warn({ eventErr, productId: id }, 'Warning: Failed to publish product.updated event');
    }

    return updated;
  }

  /**
   * Deletes product in MySQL and invalidates Redis individual and list caches.
   */
  public async deleteProduct(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw new HttpError(404, 'Product not found');
    }

    // 1. Delete from MySQL
    await this.repo.delete(id);

    // 2. Invalidate cache and analytics
    try {
      await this.cache.invalidateProduct(id);
      await this.analytics.cleanupProductAnalytics(id);
    } catch (cacheErr) {
      logger.error({ cacheErr, productId: id }, 'Warning: Cache/analytics cleanup failed after product deletion');
    }

    // 3. Publish product.deleted domain event to Pub/Sub and Streams
    try {
      const event = this.eventPublisher.createEvent(
        'product.deleted',
        'products-service',
        {
          productId: id,
        },
      );
      await this.eventPublisher.publishDomainEvent(PubSubChannel.PRODUCTS, event);
    } catch (eventErr) {
      logger.warn({ eventErr, productId: id }, 'Warning: Failed to publish product.deleted event');
    }
  }

  /**
   * Retrieves trending products ranked by popularity score.
   */
  public async getTrendingProducts(limit: number = 10): Promise<TrendingResponse> {
    const ranked = await this.trending.getTopRanked(limit);
    if (ranked.length === 0) {
      return { data: [], total: 0 };
    }

    const items: TrendingProduct[] = [];

    for (const item of ranked) {
      try {
        const { product } = await this.getProductById(item.productId);
        if (product && product.isActive) {
          items.push({
            product,
            score: item.score,
            rank: item.rank,
          });
        } else {
          // If product is inactive or deleted, remove from trending set
          await this.trending.removeProduct(item.productId);
        }
      } catch (err: unknown) {
        // If product was deleted from MySQL, purge stale leaderboard member
        await this.trending.removeProduct(item.productId);
      }
    }

    return {
      data: items,
      total: items.length,
    };
  }

  /**
   * Retrieves analytics metrics for a product.
   */
  public async getProductAnalytics(id: string): Promise<ProductAnalyticsResponse> {
    const product = await this.repo.findById(id);
    if (!product) {
      throw new HttpError(404, 'Product not found');
    }

    return await this.analytics.getProductAnalytics(id);
  }
}

export const productService = new ProductService();

