import { ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface AppErrorResponse {
  error: {
    message: string;
    statusCode: number;
    details?: Array<{ path: string; message: string }>;
    stack?: string;
  };
}

export class HttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: `Resource not found: ${req.method} ${req.originalUrl}`,
      statusCode: 404,
    },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details: Array<{ path: string; message: string }> | undefined = undefined;
  let stack: string | undefined = undefined;

  if (err instanceof ZodError) {
    statusCode = 400;
    message =
      'Validation failed: ' + err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    details = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
  } else if (err instanceof HttpError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (err instanceof Error) {
    if ('statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number') {
      statusCode = (err as { statusCode: number }).statusCode;
      message = err.message;
    } else {
      message = env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
    }
    if (env.NODE_ENV !== 'production') {
      stack = err.stack;
    }
  }

  logger.error(
    {
      err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      method: req.method,
      url: req.originalUrl,
      statusCode,
    },
    'Request processing error',
  );

  const responseBody: AppErrorResponse = {
    error: {
      message,
      statusCode,
      ...(details ? { details } : {}),
      ...(stack ? { stack } : {}),
    },
  };

  res.status(statusCode).json(responseBody);
}
