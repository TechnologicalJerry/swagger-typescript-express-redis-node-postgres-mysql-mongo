import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('Environment validation', () => {
  const validBaseEnv = {
    NODE_ENV: 'test',
    PORT: '3000',
    POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/redis_learning_pg',
    MYSQL_URL: 'mysql://root:password@localhost:3306/redis_learning_mysql',
    MONGO_URL: 'mongodb://root:password@localhost:27017/redis_learning_mongo',
    REDIS_URL: 'redis://:password@localhost:6379/0',
    REDIS_PASSWORD: 'password',
    CORS_ORIGIN: '*',
    SHUTDOWN_TIMEOUT_MS: '10000',
    JWT_ACCESS_SECRET: 'dev_jwt_access_secret_key_at_least_32_characters_long',
    JWT_REFRESH_SECRET: 'dev_jwt_refresh_secret_key_at_least_32_characters_long',
    OTP_SECRET: 'dev_otp_hmac_secret_key_at_least_32_characters_long',
  };

  it('successfully parses valid environment configuration', () => {
    const parsed = parseEnv(validBaseEnv);
    expect(parsed.NODE_ENV).toBe('test');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.POSTGRES_URL).toBe(validBaseEnv.POSTGRES_URL);
    expect(parsed.MYSQL_URL).toBe(validBaseEnv.MYSQL_URL);
    expect(parsed.MONGO_URL).toBe(validBaseEnv.MONGO_URL);
    expect(parsed.REDIS_URL).toBe(validBaseEnv.REDIS_URL);
    expect(parsed.REDIS_PASSWORD).toBe('password');
    expect(parsed.SHUTDOWN_TIMEOUT_MS).toBe(10000);
    expect(parsed.BCRYPT_WORK_FACTOR).toBe(10);
    expect(parsed.JWT_ACCESS_SECRET).toBe(validBaseEnv.JWT_ACCESS_SECRET);
    expect(parsed.JWT_REFRESH_SECRET).toBe(validBaseEnv.JWT_REFRESH_SECRET);
    expect(parsed.JWT_ISSUER).toBe('redis-learning-backend');
    expect(parsed.JWT_AUDIENCE).toBe('redis-learning-api');
    expect(parsed.JWT_ACCESS_EXPIRATION_SECONDS).toBe(900);
    expect(parsed.JWT_REFRESH_EXPIRATION_SECONDS).toBe(604800);
    expect(parsed.MAX_ACTIVE_SESSIONS_PER_USER).toBe(2);
    expect(parsed.OTP_EXPIRATION_SECONDS).toBe(300);
    expect(parsed.OTP_LENGTH).toBe(6);
    expect(parsed.OTP_MAX_ATTEMPTS).toBe(3);
    expect(parsed.OTP_COOLDOWN_SECONDS).toBe(60);
    expect(parsed.OTP_SECRET).toBe(validBaseEnv.OTP_SECRET);
    expect(parsed.SMTP_HOST).toBe('localhost');
    expect(parsed.SMTP_PORT).toBe(1025);
    expect(parsed.EMAIL_FROM).toBe('noreply@redis-learning.local');
    expect(parsed.RATE_LIMIT_DEFAULT_WINDOW_SECONDS).toBe(60);
    expect(parsed.RATE_LIMIT_DEFAULT_MAX_REQUESTS).toBe(100);
    expect(parsed.RATE_LIMIT_AUTH_WINDOW_SECONDS).toBe(60);
    expect(parsed.RATE_LIMIT_AUTH_MAX_REQUESTS).toBe(10);
    expect(parsed.RATE_LIMIT_OTP_WINDOW_SECONDS).toBe(300);
    expect(parsed.RATE_LIMIT_OTP_MAX_REQUESTS).toBe(5);
    expect(parsed.PRODUCT_CACHE_TTL_SECONDS).toBe(300);
    expect(parsed.PRODUCT_LIST_CACHE_TTL_SECONDS).toBe(60);
    expect(parsed.PRODUCT_CACHE_LOCK_TTL_MS).toBe(2000);
    expect(parsed.PRODUCT_CACHE_LOCK_TIMEOUT_MS).toBe(500);
    expect(parsed.PRODUCT_VIEW_AGGREGATION_INTERVAL_MS).toBe(60000);
    expect(parsed.PRODUCT_VIEW_BATCH_SIZE).toBe(100);
    expect(parsed.VIEWER_HMAC_SECRET).toBe('dev_viewer_hmac_secret_key_at_least_32_characters_long');
    expect(parsed.TRENDING_DEFAULT_LIMIT).toBe(10);
    expect(parsed.RESERVATION_DEFAULT_TTL_SECONDS).toBe(600);
    expect(parsed.RESERVATION_MAX_TTL_SECONDS).toBe(3600);
    expect(parsed.RESERVATION_LOCK_TTL_MS).toBe(5000);
    expect(parsed.RESERVATION_RECOVERY_INTERVAL_MS).toBe(30000);
    expect(parsed.REDIS_STREAM_DOMAIN_EVENTS).toBe('stream:domain-events');
    expect(parsed.REDIS_STREAM_DEAD_LETTER).toBe('stream:dead-letter:domain-events');
    expect(parsed.REDIS_STREAM_CONSUMER_GROUP).toBe('audit-log-workers');
    expect(parsed.REDIS_STREAM_CONSUMER_NAME).toBe('audit-worker-1');
    expect(parsed.REDIS_STREAM_BATCH_SIZE).toBe(10);
    expect(parsed.REDIS_STREAM_BLOCK_MS).toBe(2000);
    expect(parsed.REDIS_STREAM_MAX_RETRIES).toBe(3);
    expect(parsed.REDIS_STREAM_CLAIM_MIN_IDLE_MS).toBe(60000);
    expect(parsed.REDIS_STREAM_MAX_LEN).toBe(10000);
    expect(parsed.OUTBOX_POLL_INTERVAL_MS).toBe(10000);
  });

  it('fails fast when required database URLs are missing', () => {
    const invalidEnv = { ...validBaseEnv, POSTGRES_URL: undefined };
    expect(() => parseEnv(invalidEnv)).toThrowError(/POSTGRES_URL/);
  });

  it('fails when connection strings are invalid URLs', () => {
    const invalidEnv = { ...validBaseEnv, REDIS_URL: 'invalid-url' };
    expect(() => parseEnv(invalidEnv)).toThrowError(/REDIS_URL/);
  });

  it('fails when REDIS_PASSWORD is empty', () => {
    const invalidEnv = { ...validBaseEnv, REDIS_PASSWORD: '' };
    expect(() => parseEnv(invalidEnv)).toThrowError(/REDIS_PASSWORD/);
  });

  it('fails when JWT_ACCESS_SECRET is shorter than 32 characters', () => {
    const invalidEnv = { ...validBaseEnv, JWT_ACCESS_SECRET: 'too-short-secret' };
    expect(() => parseEnv(invalidEnv)).toThrowError(/JWT_ACCESS_SECRET/);
  });

  it('fails when JWT_REFRESH_SECRET is shorter than 32 characters', () => {
    const invalidEnv = { ...validBaseEnv, JWT_REFRESH_SECRET: 'too-short-secret' };
    expect(() => parseEnv(invalidEnv)).toThrowError(/JWT_REFRESH_SECRET/);
  });

  it('fails when OTP_SECRET is shorter than 32 characters', () => {
    const invalidEnv = { ...validBaseEnv, OTP_SECRET: 'too-short-secret' };
    expect(() => parseEnv(invalidEnv)).toThrowError(/OTP_SECRET/);
  });

  it('does not leak secret passwords in validation error message', () => {
    const secretPassword = 'SUPER_SECRET_VALUE_DO_NOT_LEAK';
    const invalidEnv = {
      ...validBaseEnv,
      PORT: 'invalid-port',
      REDIS_PASSWORD: secretPassword,
    };
    try {
      parseEnv(invalidEnv);
      expect.fail('Should have thrown validation error');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).not.toContain(secretPassword);
      expect(message).toContain('PORT');
    }
  });
});
