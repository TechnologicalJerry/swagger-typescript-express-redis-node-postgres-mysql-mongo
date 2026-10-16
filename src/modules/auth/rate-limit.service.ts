import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';

export type RateLimitAlgorithm = 'fixed' | 'sliding';

export interface RateLimitResult {
  allowed: boolean;
  totalRequests: number;
  remainingRequests: number;
  retryAfterSeconds: number;
}

/**
 * Lua script for atomic fixed-window rate limiting.
 * Uses INCR and sets EXPIRE on the first request to eliminate counter creation race conditions.
 */
const FIXED_WINDOW_LUA = `
local key = KEYS[1]
local windowSeconds = tonumber(ARGV[1])
local maxRequests = tonumber(ARGV[2])

local current = redis.call('INCR', key)
if current == 1 then
  redis.call('EXPIRE', key, windowSeconds)
end

local ttl = redis.call('TTL', key)
local allowed = current <= maxRequests
local retryAfter = (not allowed) and (ttl > 0 and ttl or windowSeconds) or 0

return { current, retryAfter, allowed and 1 or 0 }
`;

/**
 * Lua script for atomic sliding-window rate limiting using Redis Sorted Sets.
 * Prunes entries older than the sliding window, counts remaining requests,
 * and records the new request timestamp if within limits.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local memberId = ARGV[4]
local keyTtlSeconds = tonumber(ARGV[5])

local thresholdMs = nowMs - windowMs

-- 1. Prune timestamps outside the active sliding window
redis.call('ZREMRANGEBYSCORE', key, '-inf', thresholdMs)

-- 2. Count requests remaining in the current window
local count = redis.call('ZCARD', key)

if count < maxRequests then
  -- 3. Request permitted: record timestamp and member ID
  redis.call('ZADD', key, nowMs, memberId)
  redis.call('EXPIRE', key, keyTtlSeconds)
  return { count + 1, 0, 1 }
else
  -- 4. Rate limit exceeded: calculate Retry-After based on oldest timestamp
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 1
  if oldest and #oldest >= 2 then
    local oldestMs = tonumber(oldest[2])
    local diffMs = (oldestMs + windowMs) - nowMs
    if diffMs > 0 then
      retryAfter = math.ceil(diffMs / 1000)
    end
  end
  return { count, retryAfter, 0 }
end
`;

export class RateLimitService {
  private readonly redis: Redis;

  constructor(redisInstance: Redis = redis) {
    this.redis = redisInstance;
  }

  public getFixedKey(policy: string, clientKey: string): string {
    return `rate:fixed:${policy}:${clientKey}`;
  }

  public getSlidingKey(policy: string, clientKey: string): string {
    return `rate:sliding:${policy}:${clientKey}`;
  }

  /**
   * Evaluates rate limit under the specified algorithm (fixed or sliding window).
   */
  public async checkLimit(
    algorithm: RateLimitAlgorithm,
    policy: string,
    clientKey: string,
    maxRequests: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      if (algorithm === 'fixed') {
        const key = this.getFixedKey(policy, clientKey);
        const result = (await this.redis.eval(
          FIXED_WINDOW_LUA,
          1,
          key,
          windowSeconds.toString(),
          maxRequests.toString(),
        )) as [number, number, number];

        const totalRequests = Number(result[0]);
        const retryAfterSeconds = Number(result[1]);
        const allowed = Number(result[2]) === 1;

        return {
          allowed,
          totalRequests,
          remainingRequests: Math.max(0, maxRequests - totalRequests),
          retryAfterSeconds,
        };
      } else {
        const key = this.getSlidingKey(policy, clientKey);
        const nowMs = Date.now();
        const windowMs = windowSeconds * 1000;
        const memberId = `${nowMs}:${crypto.randomUUID()}`;
        // TTL buffer ensures the key remains slightly beyond the active window
        const keyTtlSeconds = windowSeconds + 10;

        const result = (await this.redis.eval(
          SLIDING_WINDOW_LUA,
          1,
          key,
          nowMs.toString(),
          windowMs.toString(),
          maxRequests.toString(),
          memberId,
          keyTtlSeconds.toString(),
        )) as [number, number, number];

        const totalRequests = Number(result[0]);
        const retryAfterSeconds = Number(result[1]);
        const allowed = Number(result[2]) === 1;

        return {
          allowed,
          totalRequests,
          remainingRequests: Math.max(0, maxRequests - totalRequests),
          retryAfterSeconds,
        };
      }
    } catch (err: unknown) {
      logger.error({ err, algorithm, policy, clientKey }, 'Rate limiting evaluation failed');
      // Fail closed on Redis error: throw structured error
      throw new HttpError(500, 'Rate limiting service temporarily unavailable');
    }
  }
}

export const rateLimitService = new RateLimitService();
