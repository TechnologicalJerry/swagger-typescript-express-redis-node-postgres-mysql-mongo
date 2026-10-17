import { mysqlDb } from '../../db/mysql/client.js';
import type {
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryFilters,
  ProductStatistic,
} from './products.types.js';

export interface RawProductRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: { toString(): string } | number | string;
  currency: string;
  sku: string;
  category: string;
  is_active?: boolean;
  isActive?: boolean;
  created_at?: Date;
  createdAt?: Date;
  updated_at?: Date;
  updatedAt?: Date;
}

export interface ProductDelegate {
  create(args: { data: Record<string, unknown> }): Promise<RawProductRecord>;
  findUnique(args: { where: { id?: string; sku?: string; slug?: string } }): Promise<RawProductRecord | null>;
  findMany(args: {
    where?: Record<string, unknown>;
    skip?: number;
    take?: number;
    orderBy?: Record<string, 'asc' | 'desc'>[];
  }): Promise<RawProductRecord[]>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<RawProductRecord>;
  delete(args: { where: { id: string } }): Promise<RawProductRecord>;
}

export interface MySqlPrismaClient {
  product: ProductDelegate;
}

function toProduct(raw: RawProductRecord): Product {
  const priceStr =
    typeof raw.price === 'object' && raw.price !== null && 'toString' in raw.price
      ? raw.price.toString()
      : Number(raw.price).toFixed(2);

  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    description: raw.description,
    price: priceStr,
    currency: raw.currency,
    sku: raw.sku,
    category: raw.category,
    isActive: raw.isActive ?? raw.is_active ?? true,
    createdAt: (raw.createdAt || raw.created_at || new Date()).toISOString(),
    updatedAt: (raw.updatedAt || raw.updated_at || new Date()).toISOString(),
  };
}

export class ProductRepository {
  private readonly db: MySqlPrismaClient;

  constructor(db: MySqlPrismaClient = (mysqlDb as unknown as MySqlPrismaClient)) {
    this.db = db;
  }

  public async create(data: CreateProductInput & { slug: string }): Promise<Product> {
    const raw = await this.db.product.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        price: data.price,
        currency: data.currency || 'USD',
        sku: data.sku,
        category: data.category,
        isActive: data.isActive !== undefined ? data.isActive : true,
      },
    });

    return toProduct(raw);
  }

  public async findById(id: string): Promise<Product | null> {
    const raw = await this.db.product.findUnique({
      where: { id },
    });

    return raw ? toProduct(raw) : null;
  }

  public async findBySlug(slug: string): Promise<Product | null> {
    const raw = await this.db.product.findUnique({
      where: { slug },
    });

    return raw ? toProduct(raw) : null;
  }

  public async findBySku(sku: string): Promise<Product | null> {
    const raw = await this.db.product.findUnique({
      where: { sku },
    });

    return raw ? toProduct(raw) : null;
  }

  public async findMany(
    filters: ProductQueryFilters,
  ): Promise<{ products: Product[]; total: number }> {
    const page = filters.page || 1;
    const limit = filters.limit || 10;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (filters.category) {
      where.category = filters.category;
    }
    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    const [rawList, total] = await Promise.all([
      this.db.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }],
      }),
      this.db.product.count({ where }),
    ]);

    return {
      products: rawList.map(toProduct),
      total,
    };
  }

  public async update(id: string, data: UpdateProductInput): Promise<Product> {
    const updatePayload: Record<string, unknown> = {};

    if (data.name !== undefined) updatePayload.name = data.name;
    if (data.slug !== undefined) updatePayload.slug = data.slug;
    if (data.description !== undefined) updatePayload.description = data.description;
    if (data.price !== undefined) updatePayload.price = data.price;
    if (data.currency !== undefined) updatePayload.currency = data.currency;
    if (data.sku !== undefined) updatePayload.sku = data.sku;
    if (data.category !== undefined) updatePayload.category = data.category;
    if (data.isActive !== undefined) updatePayload.isActive = data.isActive;

    const raw = await this.db.product.update({
      where: { id },
      data: updatePayload,
    });

    return toProduct(raw);
  }

  public async delete(id: string): Promise<Product> {
    const raw = await this.db.product.delete({
      where: { id },
    });

    return toProduct(raw);
  }

  /**
   * Retrieves persisted view statistics for a product from MySQL.
   */
  public async getProductStatistic(productId: string): Promise<ProductStatistic | null> {
    try {
      const client = this.db as unknown as {
        $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
      };
      const rows = await client.$queryRawUnsafe<
        Array<{
          product_id: string;
          total_views: number | bigint | string;
          last_aggregated_at: Date | string;
          created_at: Date | string;
          updated_at: Date | string;
        }>
      >(
        'SELECT product_id, total_views, last_aggregated_at, created_at, updated_at FROM product_statistics WHERE product_id = ? LIMIT 1',
        productId,
      );

      if (!rows || rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        productId: row.product_id,
        totalViews: Number(row.total_views),
        lastAggregatedAt: new Date(row.last_aggregated_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Atomically persists a batch of counter increments to MySQL with idempotent batch deduplication.
   */
  public async persistAggregationBatch(
    batchId: string,
    items: Array<{ productId: string; delta: number }>,
  ): Promise<boolean> {
    if (items.length === 0) {
      return true;
    }

    const totalViews = items.reduce((acc, item) => acc + item.delta, 0);

    const client = this.db as unknown as {
      $transaction: <T>(
        fn: (tx: {
          $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
          $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
        }) => Promise<T>,
      ) => Promise<T>;
    };

    return await client.$transaction(async (tx) => {
      // 1. Idempotency check: has this batch already been applied?
      const existing = await tx.$queryRawUnsafe(
        'SELECT id FROM processed_aggregation_batches WHERE id = ? LIMIT 1',
        batchId,
      );
      if (Array.isArray(existing) && existing.length > 0) {
        return true;
      }

      // 2. Insert batch record
      await tx.$executeRawUnsafe(
        'INSERT INTO processed_aggregation_batches (id, item_count, total_views, processed_at) VALUES (?, ?, ?, NOW(3))',
        batchId,
        items.length,
        totalViews,
      );

      // 3. Upsert product statistics atomically
      for (const item of items) {
        await tx.$executeRawUnsafe(
          `INSERT INTO product_statistics (product_id, total_views, last_aggregated_at, created_at, updated_at)
           VALUES (?, ?, NOW(3), NOW(3), NOW(3))
           ON DUPLICATE KEY UPDATE
             total_views = total_views + VALUES(total_views),
             last_aggregated_at = VALUES(last_aggregated_at),
             updated_at = NOW(3)`,
          item.productId,
          item.delta,
        );
      }

      return true;
    });
  }
}

export const productRepository = new ProductRepository();

