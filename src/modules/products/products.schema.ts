import { z } from 'zod';

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1, 'Product name is required').max(255),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be URL-safe (lowercase alphanumeric and hyphens)')
      .optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    price: z
      .number()
      .positive('Price must be greater than zero')
      .max(99999999.99, 'Price exceeds maximum limit')
      .refine(
        (val) => Number(val.toFixed(2)) === val,
        'Price cannot have more than 2 decimal places',
      ),
    currency: z.string().trim().length(3).toUpperCase().default('USD'),
    sku: z
      .string()
      .trim()
      .min(1, 'SKU is required')
      .max(64)
      .regex(/^[A-Za-z0-9-_]+$/, 'SKU must contain alphanumeric characters, hyphens, or underscores only'),
    category: z.string().trim().min(1, 'Category is required').max(100),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be URL-safe (lowercase alphanumeric and hyphens)')
      .optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    price: z
      .number()
      .positive('Price must be greater than zero')
      .max(99999999.99, 'Price exceeds maximum limit')
      .refine(
        (val) => Number(val.toFixed(2)) === val,
        'Price cannot have more than 2 decimal places',
      )
      .optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    sku: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9-_]+$/, 'SKU must contain alphanumeric characters, hyphens, or underscores only')
      .optional(),
    category: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const productQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  category: z.string().trim().min(1).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((val) => val === 'true')
    .optional(),
  search: z.string().trim().min(1).optional(),
});

export const productIdParamSchema = z.object({
  id: z.string().trim().min(1, 'Product ID is required').max(36),
});

export const trendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
export type ProductQueryDto = z.infer<typeof productQuerySchema>;
export type TrendingQueryDto = z.infer<typeof trendingQuerySchema>;

