import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { postgresDb } from '../src/db/postgres/client.js';
import { redis } from '../src/db/redis/client.js';
import { userRepository } from '../src/modules/user/user.repository.js';
import { userService } from '../src/modules/user/user.service.js';
import { tokenService } from '../src/modules/auth/token.service.js';
import { sessionService } from '../src/modules/auth/session.service.js';
import { env } from '../src/config/env.js';

describe('Authentication and Redis Refresh-Token Sessions Module', () => {
  const testEmail = 'auth.tester@example.com';
  const testPassword = 'Password123!';
  const testDisplayName = 'Auth Tester';

  const cleanTestData = async () => {
    // 1. Clean PostgreSQL test records
    const users = await postgresDb.user.findMany({
      where: {
        email: {
          contains: 'auth.test',
        },
      },
    });

    for (const u of users) {
      await sessionService.revokeAllUserSessions(u.id);
    }

    await postgresDb.user.deleteMany({
      where: {
        email: {
          contains: 'auth.test',
        },
      },
    });
  };

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  describe('User Login (POST /api/auth/login)', () => {
    it('successfully logs in with valid credentials and returns tokens and safe user', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const res = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('tokens');
      expect(res.body.data.tokens).toHaveProperty('accessToken');
      expect(res.body.data.tokens).toHaveProperty('refreshToken');
      expect(res.body.data.tokens.tokenType).toBe('Bearer');
      expect(typeof res.body.data.tokens.expiresIn).toBe('number');

      expect(res.body.data).toHaveProperty('user');
      expect(res.body.data.user.email).toBe(testEmail);
      expect(res.body.data.user).not.toHaveProperty('password');
      expect(res.body.data.user).not.toHaveProperty('passwordHash');

      // Verify that session was created in Redis
      const user = await userRepository.findByEmail(testEmail);
      expect(user).not.toBeNull();
      const count = await sessionService.getActiveSessionCount(user!.id);
      expect(count).toBe(1);
    });

    it('normalizes email during login to match registered account', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const res = await request(app).post('/api/auth/login').send({
        email: '   AUTH.TESTER@EXAMPLE.COM   ',
        password: testPassword,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(testEmail);
    });

    it('rejects login with unknown email with uniform 401 error', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: 'unknown.auth.tester@example.com',
        password: testPassword,
      });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    it('rejects login with incorrect password with uniform 401 error', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const res = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: 'WrongPassword999!',
      });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    it('rejects login for deactivated accounts with 403 Forbidden', async () => {
      const created = await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      await userService.deactivateUser(created.id);

      const res = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Account is deactivated');
    });

    it('validates request payload and rejects invalid inputs with 400', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: 'not-an-email',
        password: '',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toBeDefined();
    });
  });

  describe('JWT Claims and Verification', () => {
    it('embeds correct claims in generated access tokens', async () => {
      const created = await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const { tokens } = await tokenService.generateTokens({
        id: created.id,
        email: created.email,
        roles: created.roles,
      });

      const payload = tokenService.verifyAccessToken(tokens.accessToken);
      expect(payload.sub).toBe(created.id);
      expect(payload.email).toBe(created.email);
      expect(payload.iss).toBe(env.JWT_ISSUER);
      expect(payload.aud).toBe(env.JWT_AUDIENCE);
      expect(payload.tokenType).toBe('ACCESS');
      expect(payload.roles).toEqual(['USER']);
      expect(payload.jti).toBeDefined();
    });

    it('rejects an access token signed with an invalid secret or algorithm', () => {
      const forgedToken = jwt.sign(
        { sub: 'hacker-id', tokenType: 'ACCESS' },
        'wrong_secret_key_used_to_forge_tokens_which_should_fail_verification',
        { algorithm: 'HS256', issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
      );

      expect(() => tokenService.verifyAccessToken(forgedToken)).toThrowError(
        /Invalid access token/,
      );
    });

    it('rejects a refresh token presented where an access token is expected', async () => {
      const created = await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const { tokens } = await tokenService.generateTokens({
        id: created.id,
        email: created.email,
        roles: created.roles,
      });

      // Present refresh token to an access-token protected endpoint
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.refreshToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Expected an access token');
    });
  });

  describe('Refresh-Token Rotation (POST /api/auth/refresh)', () => {
    it('successfully rotates a valid refresh token and returns replacement tokens', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      const originalRefreshToken = loginRes.body.data.tokens.refreshToken;

      const refreshRes = await request(app).post('/api/auth/refresh').send({
        refreshToken: originalRefreshToken,
      });

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.data.tokens).toHaveProperty('accessToken');
      expect(refreshRes.body.data.tokens).toHaveProperty('refreshToken');
      expect(refreshRes.body.data.tokens.refreshToken).not.toBe(originalRefreshToken);
    });

    it('rejects reuse of an already-rotated refresh token and revokes all sessions', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      const originalRefreshToken = loginRes.body.data.tokens.refreshToken;

      // 1. First rotation succeeds
      const firstRefresh = await request(app).post('/api/auth/refresh').send({
        refreshToken: originalRefreshToken,
      });
      expect(firstRefresh.status).toBe(200);

      // 2. Replay attempt with the original refresh token
      const replayRes = await request(app).post('/api/auth/refresh').send({
        refreshToken: originalRefreshToken,
      });

      expect(replayRes.status).toBe(401);
      expect(replayRes.body.error.message).toContain('Invalid or revoked refresh token');

      // 3. Confirm that replay invalidates even the replacement token's session
      const user = await userRepository.findByEmail(testEmail);
      const activeCount = await sessionService.getActiveSessionCount(user!.id);
      expect(activeCount).toBe(0);
    });

    it('rejects refresh when user account has been deactivated in PostgreSQL', async () => {
      const created = await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      const refreshToken = loginRes.body.data.tokens.refreshToken;

      // Deactivate user in PostgreSQL
      await userService.deactivateUser(created.id);

      const res = await request(app).post('/api/auth/refresh').send({
        refreshToken,
      });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('inactive or no longer exists');
    });

    it('handles concurrent refresh requests safely', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      const refreshToken = loginRes.body.data.tokens.refreshToken;

      // Execute 2 concurrent refresh requests with the same token
      const [res1, res2] = await Promise.all([
        request(app).post('/api/auth/refresh').send({ refreshToken }),
        request(app).post('/api/auth/refresh').send({ refreshToken }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one request must succeed (200) and the other must be rejected (401)
      expect(statuses).toEqual([200, 401]);
    });
  });

  describe('Concurrent Login & 2-Session Limit', () => {
    it('enforces maximum 2 active sessions and evicts oldest session (FIFO)', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      // Login 1
      const login1 = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });
      const refresh1 = login1.body.data.tokens.refreshToken;

      // Login 2
      const login2 = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });
      const refresh2 = login2.body.data.tokens.refreshToken;

      // Login 3 (should evict session 1)
      const login3 = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });
      const refresh3 = login3.body.data.tokens.refreshToken;

      const user = await userRepository.findByEmail(testEmail);
      const activeCount = await sessionService.getActiveSessionCount(user!.id);
      expect(activeCount).toBe(2);

      // Attempting to refresh with the evicted session 1 fails
      const evictedRes = await request(app).post('/api/auth/refresh').send({
        refreshToken: refresh1,
      });
      expect(evictedRes.status).toBe(401);

      // Sessions 2 and 3 remain valid
      const validRes2 = await request(app).post('/api/auth/refresh').send({
        refreshToken: refresh2,
      });
      expect(validRes2.status).toBe(200);

      const validRes3 = await request(app).post('/api/auth/refresh').send({
        refreshToken: refresh3,
      });
      expect(validRes3.status).toBe(200);
    });

    it('enforces session limit under simultaneous concurrent login requests', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      // Trigger 4 concurrent login requests
      const loginRequests = Array.from({ length: 4 }).map(() =>
        request(app).post('/api/auth/login').send({
          email: testEmail,
          password: testPassword,
        }),
      );

      const responses = await Promise.all(loginRequests);
      responses.forEach((res) => expect(res.status).toBe(200));

      const user = await userRepository.findByEmail(testEmail);
      const activeCount = await sessionService.getActiveSessionCount(user!.id);
      // Session limit must remain bounded by 2
      expect(activeCount).toBeLessThanOrEqual(2);
    });
  });

  describe('User Logout (POST /api/auth/logout)', () => {
    it('revokes session on logout and makes repeated logout requests safe', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      const { accessToken, refreshToken } = loginRes.body.data.tokens;

      // First logout call
      const logout1 = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });

      expect(logout1.status).toBe(200);
      expect(logout1.body.message).toBe('Logged out successfully');

      // Refresh token can no longer be refreshed
      const refreshRes = await request(app).post('/api/auth/refresh').send({
        refreshToken,
      });
      expect(refreshRes.status).toBe(401);

      // Repeated logout request is idempotent and returns 200
      const logout2 = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });

      expect(logout2.status).toBe(200);
    });
  });

  describe('Current User Profile (GET /api/auth/me)', () => {
    it('returns safe user details for an authenticated caller', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: testEmail,
        password: testPassword,
      });

      const { accessToken } = loginRes.body.data.tokens;

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(testEmail);
      expect(res.body.data.user.displayName).toBe(testDisplayName);
      expect(res.body.data.user).not.toHaveProperty('passwordHash');
    });

    it('rejects request with missing Authorization header', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Missing Authorization header');
    });

    it('rejects request with malformed Authorization header', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', 'NotBearer token');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Expected "Authorization: Bearer <token>"');
    });
  });

  describe('Failure Scenarios and Resilience', () => {
    it('fails closed when Redis is unavailable during session creation', async () => {
      await userService.createUser({
        displayName: testDisplayName,
        email: testEmail,
        password: testPassword,
      });

      // Simulate Redis downtime by temporarily replacing sessionService.createSession
      const originalCreate = sessionService.createSession.bind(sessionService);
      sessionService.createSession = async () => {
        throw new Error('Redis connection timed out');
      };

      try {
        const res = await request(app).post('/api/auth/login').send({
          email: testEmail,
          password: testPassword,
        });

        expect(res.status).toBe(500);
        expect(res.body.error.message).toBe('Session store unavailable');
      } finally {
        sessionService.createSession = originalCreate;
      }
    });

    it('handles PostgreSQL failure during authentication without disclosing internal errors', async () => {
      const originalFind = userRepository.findByEmail.bind(userRepository);
      userRepository.findByEmail = async () => {
        throw new Error('Database connection lost');
      };

      try {
        const res = await request(app).post('/api/auth/login').send({
          email: testEmail,
          password: testPassword,
        });

        expect(res.status).toBe(500);
        expect(res.body.error.message).not.toContain('Database connection lost');
      } finally {
        userRepository.findByEmail = originalFind;
      }
    });
  });
});
