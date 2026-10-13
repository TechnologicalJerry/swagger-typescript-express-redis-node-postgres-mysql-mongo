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
