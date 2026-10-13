import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/client.js';
import { env } from '../../config/env.js';
import { logger, redactConnectionString } from '../../config/logger.js';

export class MySqlClient {
  private static instance: MySqlClient | null = null;
  public readonly adapter: PrismaMariaDb;
  public readonly prisma: PrismaClient;

  private constructor() {
    this.adapter = new PrismaMariaDb(env.MYSQL_URL);
    this.prisma = new PrismaClient({ adapter: this.adapter });
    logger.info(
      { endpoint: redactConnectionString(env.MYSQL_URL) },
      'MySQL Prisma client initialized',
    );
  }

  public static getInstance(): MySqlClient {
    if (!MySqlClient.instance) {
      MySqlClient.instance = new MySqlClient();
    }
    return MySqlClient.instance;
  }

  public async checkHealth(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  public async disconnect(): Promise<void> {
    logger.info('Disconnecting MySQL client');
    await this.prisma.$disconnect();
  }
}

export const mySqlClient = MySqlClient.getInstance();
export const mysqlDb = mySqlClient.prisma;
