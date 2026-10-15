import type { Redis } from 'ioredis';
import { redis } from '../../db/redis/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { SessionMetadata } from './auth.types.js';

/**
 * Lua script for atomic session creation with concurrency control and FIFO eviction.
 * Uses Redis Cluster hash tag {userId} to ensure all keys map to the same hash slot.
 */
const REGISTER_SESSION_LUA = `
local sessionsKey = KEYS[1]
local newSessionKey = KEYS[2]
local userId = ARGV[1]
local tokenId = ARGV[2]
local createdAt = ARGV[3]
local expiresAt = ARGV[4]
local userAgent = ARGV[5]
local ipAddress = ARGV[6]
local ttlSeconds = tonumber(ARGV[7])
local maxSessions = tonumber(ARGV[8])
local nowTimestamp = tonumber(ARGV[9])

-- 1. Prune dead or expired sessions from the sorted set index
local existingTokens = redis.call('ZRANGE', sessionsKey, 0, -1)
for _, tid in ipairs(existingTokens) do
  local sessionKey = "refresh:{" .. userId .. "}:" .. tid
  if redis.call('EXISTS', sessionKey) == 0 then
    redis.call('ZREM', sessionsKey, tid)
  end
end

-- 2. Enforce active session limit by evicting oldest sessions (FIFO order by score)
local currentCount = redis.call('ZCARD', sessionsKey)
if currentCount >= maxSessions then
  local excess = currentCount - maxSessions + 1
  local oldestTokens = redis.call('ZRANGE', sessionsKey, 0, excess - 1)
  for _, oldTid in ipairs(oldestTokens) do
    local oldSessionKey = "refresh:{" .. userId .. "}:" .. oldTid
    redis.call('DEL', oldSessionKey)
    redis.call('ZREM', sessionsKey, oldTid)
  end
end

-- 3. Store session metadata in a Redis Hash
redis.call('HSET', newSessionKey,
  'userId', userId,
  'tokenId', tokenId,
  'createdAt', createdAt,
  'expiresAt', expiresAt,
  'userAgent', userAgent,
  'ipAddress', ipAddress
)
redis.call('EXPIRE', newSessionKey, ttlSeconds)

-- 4. Add token to user sessions sorted set with creation timestamp as score
redis.call('ZADD', sessionsKey, nowTimestamp, tokenId)
redis.call('EXPIRE', sessionsKey, ttlSeconds)

return 1
`;

/**
 * Lua script for atomic refresh token rotation.
 * Ensures the old session exists before replacing it, preventing duplicate rotation races.
 */
const ROTATE_SESSION_LUA = `
local sessionsKey = KEYS[1]
local oldSessionKey = KEYS[2]
local newSessionKey = KEYS[3]
local userId = ARGV[1]
local oldTokenId = ARGV[2]
local newTokenId = ARGV[3]
local createdAt = ARGV[4]
local expiresAt = ARGV[5]
local userAgent = ARGV[6]
local ipAddress = ARGV[7]
local ttlSeconds = tonumber(ARGV[8])
local nowTimestamp = tonumber(ARGV[9])

-- 1. Verify that old session still exists in Redis
if redis.call('EXISTS', oldSessionKey) == 0 then
  return 0
end

-- 2. Atomically delete old session key and remove from index
redis.call('DEL', oldSessionKey)
redis.call('ZREM', sessionsKey, oldTokenId)

-- 3. Create replacement session metadata
redis.call('HSET', newSessionKey,
  'userId', userId,
  'tokenId', newTokenId,
  'createdAt', createdAt,
  'expiresAt', expiresAt,
  'userAgent', userAgent,
  'ipAddress', ipAddress
)
redis.call('EXPIRE', newSessionKey, ttlSeconds)

-- 4. Update index with new token ID
redis.call('ZADD', sessionsKey, nowTimestamp, newTokenId)
redis.call('EXPIRE', sessionsKey, ttlSeconds)

return 1
`;

/**
 * Lua script to revoke all active sessions for a user (used on replay detection or full logout).
 */
const REVOKE_ALL_SESSIONS_LUA = `
local sessionsKey = KEYS[1]
local userId = ARGV[1]

local tokens = redis.call('ZRANGE', sessionsKey, 0, -1)
for _, tid in ipairs(tokens) do
  local sessionKey = "refresh:{" .. userId .. "}:" .. tid
  redis.call('DEL', sessionKey)
end
redis.call('DEL', sessionsKey)

return #tokens
`;

export class SessionService {
  private readonly redis: Redis;
  public readonly ttlSeconds: number;
  public readonly maxSessions: number;

  constructor(
    redisInstance: Redis = redis,
    ttlSeconds: number = env.JWT_REFRESH_EXPIRATION_SECONDS,
    maxSessions: number = env.MAX_ACTIVE_SESSIONS_PER_USER,
  ) {
    this.redis = redisInstance;
    this.ttlSeconds = ttlSeconds;
    this.maxSessions = maxSessions;
  }

  /**
   * Constructs the Redis key for an individual refresh session.
   * Pattern: refresh:{userId}:{tokenId} (hash-tagged for Redis Cluster compatibility)
   */
  public getSessionKey(userId: string, tokenId: string): string {
    return `refresh:{${userId}}:${tokenId}`;
  }

  /**
   * Constructs the Redis key for a user's active session index.
   * Pattern: user_sessions:{userId} (hash-tagged for Redis Cluster compatibility)
   */
  public getUserSessionsKey(userId: string): string {
    return `user_sessions:{${userId}}`;
  }

  /**
   * Registers a new refresh-token session atomically with FIFO eviction of older sessions.
   */
  public async createSession(
    userId: string,
    tokenId: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);
    const sessionsKey = this.getUserSessionsKey(userId);
    const sessionKey = this.getSessionKey(userId, tokenId);

    try {
      await this.redis.eval(
        REGISTER_SESSION_LUA,
        2,
        sessionsKey,
        sessionKey,
        userId,
        tokenId,
        now.toISOString(),
        expiresAt.toISOString(),
        metadata?.userAgent || '',
        metadata?.ipAddress || '',
        this.ttlSeconds.toString(),
        this.maxSessions.toString(),
        now.getTime().toString(),
      );
    } catch (err: unknown) {
      logger.error({ err, userId, tokenId }, 'Failed to create Redis refresh-token session');
      throw new HttpError(500, 'Session store unavailable');
    }
  }

  /**
   * Retrieves session metadata for a given user and token identifier.
   */
  public async getSession(userId: string, tokenId: string): Promise<SessionMetadata | null> {
    const sessionKey = this.getSessionKey(userId, tokenId);

    try {
      const data = await this.redis.hgetall(sessionKey);
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return {
        userId: data.userId || userId,
        tokenId: data.tokenId || tokenId,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
        userAgent: data.userAgent || undefined,
        ipAddress: data.ipAddress || undefined,
      };
    } catch (err: unknown) {
      logger.error({ err, userId, tokenId }, 'Failed to query Redis refresh-token session');
      throw new HttpError(500, 'Session store unavailable');
    }
  }

  /**
   * Atomically rotates an existing refresh-token session to a new session.
   * Returns true on successful rotation, or false if the old session does not exist (replay/revoked).
   */
  public async rotateSession(
    userId: string,
    oldTokenId: string,
    newTokenId: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);
    const sessionsKey = this.getUserSessionsKey(userId);
    const oldSessionKey = this.getSessionKey(userId, oldTokenId);
    const newSessionKey = this.getSessionKey(userId, newTokenId);

    try {
      const result = await this.redis.eval(
        ROTATE_SESSION_LUA,
        3,
        sessionsKey,
        oldSessionKey,
        newSessionKey,
        userId,
        oldTokenId,
        newTokenId,
        now.toISOString(),
        expiresAt.toISOString(),
        metadata?.userAgent || '',
        metadata?.ipAddress || '',
        this.ttlSeconds.toString(),
        now.getTime().toString(),
      );

      const success = Number(result) === 1;
      if (success) {
        await this.markAsRotated(userId, oldTokenId);
      }
      return success;
    } catch (err: unknown) {
      logger.error({ err, userId, oldTokenId }, 'Failed to rotate Redis refresh-token session');
      throw new HttpError(500, 'Session store unavailable');
    }
  }

  public getRotatedKey(tokenId: string): string {
    return `refresh:rotated:${tokenId}`;
  }

  public async markAsRotated(userId: string, tokenId: string): Promise<void> {
    try {
      await this.redis.set(this.getRotatedKey(tokenId), userId, 'EX', 86400);
    } catch (err: unknown) {
      logger.warn({ err, tokenId }, 'Failed to mark token as rotated in Redis');
    }
  }

  public async isRotated(tokenId: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(this.getRotatedKey(tokenId));
      return exists === 1;
    } catch (err: unknown) {
      logger.warn({ err, tokenId }, 'Failed to check rotated token status');
      return false;
    }
  }

  /**
   * Revokes a specific refresh-token session. Safe and idempotent.
   */
  public async revokeSession(userId: string, tokenId: string): Promise<void> {
    const sessionsKey = this.getUserSessionsKey(userId);
    const sessionKey = this.getSessionKey(userId, tokenId);

    try {
      // Pipeline deletion of session key and removal from the user's sorted set
      const pipeline = this.redis.pipeline();
      pipeline.del(sessionKey);
      pipeline.zrem(sessionsKey, tokenId);
      await pipeline.exec();
    } catch (err: unknown) {
      logger.error({ err, userId, tokenId }, 'Failed to revoke Redis refresh-token session');
      throw new HttpError(500, 'Session store unavailable');
    }
  }

  /**
   * Revokes all active sessions for a user (e.g., when refresh token reuse/theft is detected).
   */
  public async revokeAllUserSessions(userId: string): Promise<number> {
    const sessionsKey = this.getUserSessionsKey(userId);

    try {
      const count = await this.redis.eval(REVOKE_ALL_SESSIONS_LUA, 1, sessionsKey, userId);
      return Number(count);
    } catch (err: unknown) {
      logger.error({ err, userId }, 'Failed to revoke all user sessions in Redis');
      throw new HttpError(500, 'Session store unavailable');
    }
  }

  /**
   * Retrieves the count of currently registered active sessions for a user.
   */
  public async getActiveSessionCount(userId: string): Promise<number> {
    const sessionsKey = this.getUserSessionsKey(userId);

    try {
      return await this.redis.zcard(sessionsKey);
    } catch (err: unknown) {
      logger.error({ err, userId }, 'Failed to count user sessions in Redis');
      throw new HttpError(500, 'Session store unavailable');
    }
  }
}

export const sessionService = new SessionService();
