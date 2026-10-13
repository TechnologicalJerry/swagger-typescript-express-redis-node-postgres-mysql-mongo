import { describe, it, expect, afterAll } from 'vitest';
import { postgresClient } from '../src/db/postgres/client.js';
import { mySqlClient } from '../src/db/mysql/client.js';
import { mongoClient } from '../src/db/mongo/client.js';
import { redisClient } from '../src/db/redis/client.js';

describe('Real Database Connectivity', () => {
  afterAll(async () => {
    await Promise.allSettled([
      postgresClient.disconnect(),
      mySqlClient.disconnect(),
      mongoClient.disconnect(),
      redisClient.disconnect(),
    ]);
  });

  it('connects to PostgreSQL 18 container and executes read-only query', async () => {
    await expect(postgresClient.checkHealth()).resolves.toBeUndefined();
  });

  it('connects to MySQL 8.4 container and executes read-only query', async () => {
    await expect(mySqlClient.checkHealth()).resolves.toBeUndefined();
  });

  it('connects to MongoDB 8.0 container and executes ping', async () => {
    await expect(mongoClient.checkHealth()).resolves.toBeUndefined();
  });

  it('connects to Redis 8.6 container and executes PING', async () => {
    await expect(redisClient.checkHealth()).resolves.toBeUndefined();
  });

  it('GET /ready returns 200 with all dependencies up against live docker containers', async () => {
    const { app } = await import('../src/app.js');
    const { default: request } = await import('supertest');
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.dependencies.postgres.status).toBe('up');
    expect(res.body.dependencies.mysql.status).toBe('up');
    expect(res.body.dependencies.mongo.status).toBe('up');
    expect(res.body.dependencies.redis.status).toBe('up');
  });
});
