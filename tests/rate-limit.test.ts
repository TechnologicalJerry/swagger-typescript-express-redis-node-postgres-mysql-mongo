import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { redis } from '../src/db/redis/client.js';
import { rateLimitService } from '../src/modules/auth/rate-limit.service.js';
import { createRateLimiter } from '../src/middleware/rateLimiter.js';

describe('Rate Limiting (Fixed-Window & Sliding-Window)', () => {
  const cleanRateLimitKeys = async () => {
    const fixedKeys = await redis.keys('rate:fixed:test:*');
    if (fixedKeys.length > 0) await redis.del(...fixedKeys);

    const slidingKeys = await redis.keys('rate:sliding:test:*');
    if (slidingKeys.length > 0) await redis.del(...slidingKeys);
  };

  beforeEach(async () => {
    await cleanRateLimitKeys();
  });

  afterAll(async () => {
    await cleanRateLimitKeys();
  });

  describe('Feature C — Fixed-Window Rate Limiter', () => {
    it('allows requests below limit and sets standard headers', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          policy: 'test:fixed:basic',
          maxRequests: 3,
          windowSeconds: 60,
          algorithm: 'fixed',
          keyGenerator: () => 'client-1',
        }),
      );
      app.get('/test', (_req, res) => res.json({ status: 'ok' }));

      // Request 1
      const res1 = await request(app).get('/test');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-limit']).toBe('3');
      expect(res1.headers['x-ratelimit-remaining']).toBe('2');

      // Request 2
      const res2 = await request(app).get('/test');
      expect(res2.status).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('1');

      // Request 3
      const res3 = await request(app).get('/test');
      expect(res3.status).toBe(200);
      expect(res3.headers['x-ratelimit-remaining']).toBe('0');
    });

    it('rejects requests exceeding limit with 429 and Retry-After header', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          policy: 'test:fixed:overflow',
          maxRequests: 2,
          windowSeconds: 60,
          algorithm: 'fixed',
          keyGenerator: () => 'client-overflow',
        }),
      );
      app.get('/test', (_req, res) => res.json({ status: 'ok' }));

      await request(app).get('/test');
      await request(app).get('/test');

      // 3rd request exceeds limit
      const blockedRes = await request(app).get('/test');
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.message).toContain('Too many requests');
      expect(blockedRes.headers).toHaveProperty('retry-after');
      const retryAfter = Number(blockedRes.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it('sets TTL on newly created counter correctly', async () => {
      const clientKey = 'client-ttl';
      const policy = 'test:fixed:ttl';

      await rateLimitService.checkLimit('fixed', policy, clientKey, 5, 30);

      const key = rateLimitService.getFixedKey(policy, clientKey);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it('prevents concurrent requests from bypassing the fixed limit', async () => {
      const clientKey = 'client-concurrent-fixed';
      const policy = 'test:fixed:concurrent';
      const maxRequests = 5;

      const requests = Array.from({ length: 15 }).map(() =>
        rateLimitService.checkLimit('fixed', policy, clientKey, maxRequests, 60),
      );

      const results = await Promise.all(requests);
      const allowedCount = results.filter((r) => r.allowed).length;
      const blockedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(maxRequests);
      expect(blockedCount).toBe(10);
    });
  });

  describe('Feature D — Sliding-Window Rate Limiter', () => {
    it('allows requests within sliding window and records requests', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          policy: 'test:sliding:basic',
          maxRequests: 3,
          windowSeconds: 60,
          algorithm: 'sliding',
          keyGenerator: () => 'client-sliding-1',
        }),
      );
      app.get('/test', (_req, res) => res.json({ status: 'ok' }));

      const res1 = await request(app).get('/test');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-remaining']).toBe('2');

      const res2 = await request(app).get('/test');
      expect(res2.status).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('1');
    });

    it('rejects requests beyond limit with 429 and calculated Retry-After', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          policy: 'test:sliding:overflow',
          maxRequests: 2,
          windowSeconds: 60,
          algorithm: 'sliding',
          keyGenerator: () => 'client-sliding-overflow',
        }),
      );
      app.get('/test', (_req, res) => res.json({ status: 'ok' }));

      await request(app).get('/test');
      await request(app).get('/test');

      const blockedRes = await request(app).get('/test');
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers).toHaveProperty('retry-after');
      const retryAfter = Number(blockedRes.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
    });

    it('prunes entries older than the sliding window', async () => {
      const clientKey = 'client-sliding-prune';
      const policy = 'test:sliding:prune';
      const key = rateLimitService.getSlidingKey(policy, clientKey);

      const now = Date.now();
      // Inject an entry that is 120 seconds old (outside 60s window)
      await redis.zadd(key, now - 120000, `old-member-${now - 120000}`);
      // Inject a fresh entry inside window
      await redis.zadd(key, now - 10000, `fresh-member-${now - 10000}`);

      // Evaluate sliding rate limit with limit of 2 over 60 seconds
      const result = await rateLimitService.checkLimit('sliding', policy, clientKey, 2, 60);

      expect(result.allowed).toBe(true);

      // Verify that old entry was removed from the sorted set
      const remainingMembers = await redis.zrange(key, 0, -1);
      expect(remainingMembers.some((m) => m.startsWith('old-member'))).toBe(false);
      expect(remainingMembers.some((m) => m.startsWith('fresh-member'))).toBe(true);
    });

    it('handles simultaneous requests with unique members without collision', async () => {
      const clientKey = 'client-sliding-collision';
      const policy = 'test:sliding:collision';
      const maxRequests = 5;

      const requests = Array.from({ length: 10 }).map(() =>
        rateLimitService.checkLimit('sliding', policy, clientKey, maxRequests, 60),
      );

      const results = await Promise.all(requests);
      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(maxRequests);

      // Confirm sorted set contains exactly maxRequests members
      const key = rateLimitService.getSlidingKey(policy, clientKey);
      const card = await redis.zcard(key);
      expect(card).toBe(maxRequests);
    });

    it('sets TTL on sliding-window sorted set so inactive keys expire', async () => {
      const clientKey = 'client-sliding-ttl';
      const policy = 'test:sliding:ttl';

      await rateLimitService.checkLimit('sliding', policy, clientKey, 5, 45);

      const key = rateLimitService.getSlidingKey(policy, clientKey);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(55); // 45 + 10s buffer
    });
  });
});
