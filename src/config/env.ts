import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env variables into process.env
dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  POSTGRES_URL: z.string().url('POSTGRES_URL must be a valid URL'),
  MYSQL_URL: z.string().url('MYSQL_URL must be a valid URL'),
  MONGO_URL: z.string().url('MONGO_URL must be a valid URL'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  REDIS_PASSWORD: z.string().min(1, 'REDIS_PASSWORD is required'),
  CORS_ORIGIN: z.string().default('*'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  BCRYPT_WORK_FACTOR: z.coerce.number().int().min(4).max(16).default(10),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters long'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters long'),
  JWT_ISSUER: z.string().min(1).default('redis-learning-backend'),
  JWT_AUDIENCE: z.string().min(1).default('redis-learning-api'),
  JWT_ACCESS_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(604800),
  MAX_ACTIVE_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(10).default(2),
  OTP_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  OTP_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters long'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@redis-learning.local'),
  RATE_LIMIT_DEFAULT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_DEFAULT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AUTH_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OTP_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_OTP_MAX_REQUESTS: z.coerce.number().int().positive().default(5),
  PRODUCT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PRODUCT_LIST_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  PRODUCT_CACHE_LOCK_TTL_MS: z.coerce.number().int().positive().default(2000),
  PRODUCT_CACHE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
  PRODUCT_VIEW_AGGREGATION_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  PRODUCT_VIEW_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  VIEWER_HMAC_SECRET: z
    .string()
    .min(32, 'VIEWER_HMAC_SECRET must be at least 32 characters long')
    .default('dev_viewer_hmac_secret_key_at_least_32_characters_long'),
  TRENDING_DEFAULT_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  RESERVATION_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(10).max(86400).default(600),
  RESERVATION_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  RESERVATION_LOCK_TTL_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  RESERVATION_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
  REDIS_STREAM_DOMAIN_EVENTS: z.string().min(1).default('stream:domain-events'),
  REDIS_STREAM_DEAD_LETTER: z.string().min(1).default('stream:dead-letter:domain-events'),
  REDIS_STREAM_CONSUMER_GROUP: z.string().min(1).default('audit-log-workers'),
  REDIS_STREAM_CONSUMER_NAME: z.string().min(1).default('audit-worker-1'),
  REDIS_STREAM_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_STREAM_BLOCK_MS: z.coerce.number().int().min(100).max(30000).default(2000),
  REDIS_STREAM_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  REDIS_STREAM_CLAIM_MIN_IDLE_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  REDIS_STREAM_MAX_LEN: z.coerce.number().int().min(100).max(1000000).default(10000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(600000).default(10000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the raw environment dictionary and produces strongly typed environment configuration.
 * Never leaks passwords or raw secret values in validation errors.
 */
export function parseEnv(rawEnv: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${errorMessages}`);
  }
  return result.data;
}

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    try {
      cachedEnv = parseEnv(process.env);
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error((err as Error).message);
        process.exit(1);
      }
      throw err;
    }
  }
  return cachedEnv;
}

export const env = getEnv();
