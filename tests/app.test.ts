import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, type HealthChecker } from '../src/app.js';
import { HttpError } from '../src/middleware/errorHandler.js';

describe('Application Endpoints', () => {
  const healthyCheckers: HealthChecker = {
    checkPostgres: async () => {},
    checkMysql: async () => {},
    checkMongo: async () => {},
    checkRedis: async () => {},
  };

  describe('GET /health (Liveness)', () => {
    it('returns 200 OK with liveness metadata', async () => {
      const app = createApp(healthyCheckers);
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('remains healthy even when database dependencies are failing', async () => {
      const failingCheckers: HealthChecker = {
        checkPostgres: async () => {
          throw new Error('Database down');
        },
        checkMysql: async () => {
          throw new Error('Database down');
        },
        checkMongo: async () => {
          throw new Error('Database down');
        },
        checkRedis: async () => {
          throw new Error('Database down');
        },
      };

      const app = createApp(failingCheckers);
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /ready (Readiness)', () => {
    it('returns 200 OK when all 4 databases are healthy', async () => {
      const app = createApp(healthyCheckers);
      const res = await request(app).get('/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.dependencies).toEqual({
        postgres: { status: 'up' },
        mysql: { status: 'up' },
        mongo: { status: 'up' },
        redis: { status: 'up' },
      });
    });

    it('returns 503 Service Unavailable when PostgreSQL fails', async () => {
      const failingPostgres: HealthChecker = {
        ...healthyCheckers,
        checkPostgres: async () => {
          throw new Error('Connection refused');
        },
      };

      const app = createApp(failingPostgres);
      const res = await request(app).get('/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.postgres.status).toBe('down');
      expect(res.body.dependencies.mysql.status).toBe('up');
      expect(res.body.dependencies.mongo.status).toBe('up');
      expect(res.body.dependencies.redis.status).toBe('up');
    });

    it('returns 503 Service Unavailable when MySQL fails', async () => {
      const failingMysql: HealthChecker = {
        ...healthyCheckers,
        checkMysql: async () => {
          throw new Error('Connection timed out');
        },
      };

      const app = createApp(failingMysql);
      const res = await request(app).get('/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.mysql.status).toBe('down');
    });

    it('returns 503 Service Unavailable when MongoDB fails', async () => {
      const failingMongo: HealthChecker = {
        ...healthyCheckers,
        checkMongo: async () => {
          throw new Error('MongoDB database instance is unavailable');
        },
      };

      const app = createApp(failingMongo);
      const res = await request(app).get('/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.mongo.status).toBe('down');
    });

    it('returns 503 Service Unavailable when Redis fails', async () => {
      const failingRedis: HealthChecker = {
        ...healthyCheckers,
        checkRedis: async () => {
          throw new Error('Connection refused');
        },
      };

      const app = createApp(failingRedis);
      const res = await request(app).get('/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.redis.status).toBe('down');
    });
  });

  describe('Centralized 404 handler', () => {
    it('returns structured 404 response for unknown routes', async () => {
      const app = createApp(healthyCheckers);
      const res = await request(app).get('/api/non-existent-endpoint');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: {
          message: 'Resource not found: GET /api/non-existent-endpoint',
          statusCode: 404,
        },
      });
    });
  });

  describe('Centralized error handler', () => {
    it('returns structured error response for HttpError', async () => {
      const app = createApp(healthyCheckers, (testApp) => {
        testApp.get('/test-error', () => {
          throw new HttpError(400, 'Bad request test');
        });
      });

      const res = await request(app).get('/test-error');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Bad request test');
      expect(res.body.error.statusCode).toBe(400);
    });

    it('returns generic error response for unexpected Error', async () => {
      const app = createApp(healthyCheckers, (testApp) => {
        testApp.get('/test-unhandled', () => {
          throw new Error('Unexpected crash');
        });
      });

      const res = await request(app).get('/test-unhandled');
      expect(res.status).toBe(500);
      expect(res.body.error.statusCode).toBe(500);
    });
  });
});
