import type { Request, Response } from 'express';
import { ProductService, productService } from './products.service.js';
import {
  createProductSchema,
  updateProductSchema,
  productIdParamSchema,
  productQuerySchema,
  trendingQuerySchema,
} from './products.schema.js';
import { productAnalyticsService, ProductAnalyticsService } from './product-analytics.service.js';
import { HttpError } from '../../middleware/errorHandler.js';

export class ProductController {
  private readonly service: ProductService;
  private readonly analytics: ProductAnalyticsService;

  constructor(
    service: ProductService = productService,
    analytics: ProductAnalyticsService = productAnalyticsService,
  ) {
    this.service = service;
    this.analytics = analytics;
  }

  private shouldBypassCache(req: Request): boolean {
    const skipHeader = req.headers['x-skip-cache'];
    const cacheControl = req.headers['cache-control'];
    return skipHeader === 'true' || cacheControl === 'no-cache';
  }

  /**
   * Resolves a raw client identifier for privacy-safe viewer token hashing.
   */
  private resolveViewerIdentifier(req: Request): string {
    if (req.user?.id) {
      return req.user.id;
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    return `${ip}:${userAgent}`;
  }

  /**
   * POST /api/products
   * Creates a new product in MySQL source of truth and invalidates list caches.
   * Requires ADMIN authorization.
   */
  public create = async (req: Request, res: Response): Promise<void> => {
    const input = createProductSchema.parse(req.body);
    const product = await this.service.createProduct(input);
    res.status(201).json(product);
  };

  /**
   * GET /api/products
   * Returns a paginated list of products using query-fingerprinted cache.
   * Sets X-Cache: HIT | MISS | BYPASS.
   */
  public list = async (req: Request, res: Response): Promise<void> => {
    const query = productQuerySchema.parse(req.query);
    const bypassCache = this.shouldBypassCache(req);

    const { result, cacheState } = await this.service.listProducts(query, { bypassCache });

    res.setHeader('X-Cache', cacheState);
    res.status(200).json(result);
  };

  /**
   * GET /api/products/trending
   * Retrieves trending products ranked by popularity score in descending order.
   */
  public getTrending = async (req: Request, res: Response): Promise<void> => {
    const query = trendingQuerySchema.parse(req.query);
    const result = await this.service.getTrendingProducts(query.limit);
    res.status(200).json(result);
  };

  /**
   * GET /api/products/:id
   * Retrieves an individual product using Redis Cache-Aside and stampede lock protection.
   * Asynchronously counts qualifying views via Redis INCR, HyperLogLog, and Trending ZINCRBY.
   * Sets X-Cache: HIT | MISS | BYPASS.
   */
  public getById = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const bypassCache = this.shouldBypassCache(req);

    const { product, cacheState } = await this.service.getProductById(params.id, {
      bypassCache,
    });

    // Qualifying view check:
    // Only records views for active products viewed by non-admin callers (excludes internal/admin operations).
    // Asynchronous and non-blocking: Never delays HTTP response or depends on immediate MySQL writes.
    const isAdmin = req.user?.role === 'ADMIN';
    if (!isAdmin && product.isActive) {
      const viewerId = this.resolveViewerIdentifier(req);
      void this.analytics.recordProductView(product.id, viewerId);
    }

    res.setHeader('X-Cache', cacheState);
    res.status(200).json(product);
  };

  /**
   * GET /api/products/:id/analytics
   * Retrieves product analytics: total views, estimated unique viewers (HyperLogLog),
   * and trending score.
   */
  public getAnalytics = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const analytics = await this.service.getProductAnalytics(params.id);
    res.status(200).json(analytics);
  };

  /**
   * PATCH /api/products/:id
   * Updates an existing product in MySQL and invalidates Redis caches.
   * Requires ADMIN authorization.
   */
  public update = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);

    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
      throw new HttpError(400, 'At least one field must be provided for update');
    }

    const input = updateProductSchema.parse(req.body);
    const updated = await this.service.updateProduct(params.id, input);
    res.status(200).json(updated);
  };

  /**
   * DELETE /api/products/:id
   * Deletes a product from MySQL and invalidates Redis caches and analytics keys.
   * Requires ADMIN authorization.
   */
  public delete = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    await this.service.deleteProduct(params.id);
    res.status(204).send();
  };
}

export const productController = new ProductController();
