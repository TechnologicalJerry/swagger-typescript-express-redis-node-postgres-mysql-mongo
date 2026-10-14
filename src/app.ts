import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { postgresClient } from './db/postgres/client.js';
import { mySqlClient } from './db/mysql/client.js';
import { mongoClient } from './db/mongo/client.js';
import { redisClient } from './db/redis/client.js';
import { userRoutes } from './modules/user/user.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';

export interface HealthChecker {
  checkPostgres(): Promise<void>;
  checkMysql(): Promise<void>;
  checkMongo(): Promise<void>;
  checkRedis(): Promise<void>;
}

export const defaultHealthChecker: HealthChecker = {
  checkPostgres: () => postgresClient.checkHealth(),
  checkMysql: () => mySqlClient.checkHealth(),
  checkMongo: () => mongoClient.checkHealth(),
  checkRedis: () => redisClient.checkHealth(),
};

async function runCheckWithTimeout(
  checkFn: () => Promise<void>,
  timeoutMs: number,
): Promise<{ status: 'up' | 'down'; error?: string }> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: 'down'; error: string }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ status: 'down', error: 'Check timed out' });
    }, timeoutMs);
  });

  const checkPromise = checkFn()
    .then(() => ({ status: 'up' as const }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      // Sanitize to avoid leaking connection strings or internal database errors
      const sanitized = message.includes('ECONNREFUSED')
        ? 'Connection refused'
        : message.includes('timed out')
          ? 'Connection timed out'
          : 'Service unavailable';
      return { status: 'down' as const, error: sanitized };
    });

  try {
    return await Promise.race([checkPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createApp(
  customChecker?: Partial<HealthChecker>,
  routeRegistrar?: (app: Express) => void,
): Express {
  const checker: HealthChecker = {
    ...defaultHealthChecker,
    ...customChecker,
  };

  const app = express();

  // Security and utilities middleware
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  if (routeRegistrar) {
    routeRegistrar(app);
  }

  /**
   * GET /health - Liveness probe
   * Returns HTTP 200 when Express HTTP runtime is alive and processing requests.
   * Does NOT fail if backing databases are temporarily unavailable.
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /ready - Readiness probe
   * Checks connectivity to all four required data stores: PostgreSQL, MySQL, MongoDB, Redis.
   * Returns HTTP 200 only when all 4 stores are healthy, or 503 if any store is unhealthy.
   */
  app.get('/ready', async (_req: Request, res: Response) => {
    const timeoutMs = 3000;

    const [postgres, mysql, mongo, redis] = await Promise.all([
      runCheckWithTimeout(checker.checkPostgres, timeoutMs),
      runCheckWithTimeout(checker.checkMysql, timeoutMs),
      runCheckWithTimeout(checker.checkMongo, timeoutMs),
      runCheckWithTimeout(checker.checkRedis, timeoutMs),
    ]);

    const dependencies = {
      postgres,
      mysql,
      mongo,
      redis,
    };

    const isAllReady =
      postgres.status === 'up' &&
      mysql.status === 'up' &&
      mongo.status === 'up' &&
      redis.status === 'up';

    const statusCode = isAllReady ? 200 : 503;

    res.status(statusCode).json({
      status: isAllReady ? 'ready' : 'unhealthy',
      dependencies,
      timestamp: new Date().toISOString(),
    });
  });

  // User management module routes
  app.use('/api/users', userRoutes);

  // Authentication and Redis refresh-token session routes
  app.use('/api/auth', authRoutes);

  // Centralized 404 handler for unmapped routes
  app.use(notFoundHandler);

  // Centralized error handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
