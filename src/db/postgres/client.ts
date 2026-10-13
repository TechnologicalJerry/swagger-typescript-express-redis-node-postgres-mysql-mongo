import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';
import { env } from '../../config/env.js';
import { logger, redactConnectionString } from '../../config/logger.js';

const { Pool } = pg;

export class PostgresClient {
  private static instance: PostgresClient | null = null;
  public readonly pool: pg.Pool;
  public readonly adapter: PrismaPg;
  public readonly prisma: PrismaClient;

  private constructor() {
    this.pool = new Pool({
      connectionString: env.POSTGRES_URL,
    });
    this.adapter = new PrismaPg(this.pool);
    this.prisma = new PrismaClient({ adapter: this.adapter });
    logger.info(
      { endpoint: redactConnectionString(env.POSTGRES_URL) },
      'PostgreSQL Prisma client initialized',
    );
  }

  public static getInstance(): PostgresClient {
    if (!PostgresClient.instance) {
      PostgresClient.instance = new PostgresClient();
    }
    return PostgresClient.instance;
  }

  public async checkHealth(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  public async disconnect(): Promise<void> {
    logger.info('Disconnecting PostgreSQL client');
    await this.prisma.$disconnect();
    await this.pool.end();
  }
}

export const postgresClient = PostgresClient.getInstance();
export const postgresDb = postgresClient.prisma;
