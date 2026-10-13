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
