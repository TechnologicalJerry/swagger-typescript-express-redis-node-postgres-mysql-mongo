export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: string;
  currency: string;
  sku: string;
  category: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductInput {
  name: string;
  slug?: string;
  description?: string | null;
  price: number;
  currency?: string;
  sku: string;
  category: string;
  isActive?: boolean;
}

export interface UpdateProductInput {
  name?: string;
  slug?: string;
  description?: string | null;
  price?: number;
  currency?: string;
  sku?: string;
  category?: string;
  isActive?: boolean;
}

export interface ProductQueryFilters {
  page?: number;
  limit?: number;
  category?: string;
  isActive?: boolean;
  search?: string;
}

export interface PaginatedProductsResult {
  data: Product[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export type CacheState = 'HIT' | 'MISS' | 'BYPASS';

export interface ProductStatistic {
  productId: string;
  totalViews: number;
  lastAggregatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductAnalyticsResponse {
  productId: string;
  totalViews: number;
  persistedViews: number;
  unaggregatedViews: number;
  estimatedUniqueViewers: number;
  trendingScore: number;
  isEstimate: boolean;
}

export interface TrendingProduct {
  product: Product;
  score: number;
  rank: number;
}

export interface TrendingResponse {
  data: TrendingProduct[];
  total: number;
}

export interface TrendingQueryFilters {
  limit?: number;
}

export interface AggregationBatchResult {
  batchId: string;
  itemCount: number;
  totalViews: number;
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED';
}
