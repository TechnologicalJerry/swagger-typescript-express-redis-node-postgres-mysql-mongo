import type { Server } from 'http';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { postgresClient } from './db/postgres/client.js';
import { mySqlClient } from './db/mysql/client.js';
import { mongoClient } from './db/mongo/client.js';
import { redisClient } from './db/redis/client.js';

let server: Server | null = null;
let isShuttingDown = false;

export async function closeConnections(): Promise<void> {
  const results = await Promise.allSettled([
    postgresClient.disconnect(),
    mySqlClient.disconnect(),
    mongoClient.disconnect(),
    redisClient.disconnect(),
  ]);

  const clients = ['PostgreSQL', 'MySQL', 'MongoDB', 'Redis'];
  results.forEach((res, index) => {
    if (res.status === 'rejected') {
      logger.error({ client: clients[index], err: res.reason }, 'Error disconnecting client');
    } else {
      logger.info({ client: clients[index] }, 'Client disconnected cleanly');
    }
  });
}

export async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn({ signal }, 'Shutdown already in progress, ignoring duplicate signal');
    return;
  }
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExitTimeout.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      logger.info('HTTP server closed, stopped accepting new requests');
    }

    await closeConnections();
    logger.info('Graceful shutdown completed successfully');
    clearTimeout(forceExitTimeout);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

export function startServer(): Server {
  server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, nodeEnv: env.NODE_ENV },
      `Server listening on http://localhost:${env.PORT}`,
    );
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return server;
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}
