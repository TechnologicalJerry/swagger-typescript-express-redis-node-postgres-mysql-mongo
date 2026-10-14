import mongoose, { Connection } from 'mongoose';
import { env } from '../../config/env.js';
import { logger, redactConnectionString } from '../../config/logger.js';

export class MongoClient {
  private static instance: MongoClient | null = null;
  private connection: Connection | null = null;

  private constructor() { }

  public static getInstance(): MongoClient {
    if (!MongoClient.instance) {
      MongoClient.instance = new MongoClient();
    }
    return MongoClient.instance;
  }

  public async connect(): Promise<Connection> {
    if (this.connection && this.connection.readyState === 1) {
      return this.connection;
    }

    logger.info(
      { endpoint: redactConnectionString(env.MONGO_URL) },
      'Connecting to MongoDB via Mongoose',
    );

    await mongoose.connect(env.MONGO_URL, {
      serverSelectionTimeoutMS: 5000,
    });
    this.connection = mongoose.connection;
    return this.connection;
  }

  public getConnection(): Connection | null {
    return this.connection;
  }

  public async checkHealth(): Promise<void> {
    const conn = await this.connect();
    if (!conn.db) {
      throw new Error('MongoDB database instance is unavailable');
    }
    await conn.db.admin().ping();
  }

  public async disconnect(): Promise<void> {
    if (this.connection && this.connection.readyState !== 0) {
      logger.info('Disconnecting Mongoose client');
      await mongoose.disconnect();
      this.connection = null;
    }
  }
}

export const mongoClient = MongoClient.getInstance();
