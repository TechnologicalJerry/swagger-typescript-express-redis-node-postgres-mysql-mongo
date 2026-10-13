import pino from 'pino';
import { env } from './env.js';

export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = '***';
    }
    if (url.username) {
      url.username = '***';
    }
    return url.toString();
  } catch {
    return '[REDACTED_URL]';
  }
}

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  redact: {
    paths: [
      'password',
      'secret',
      'token',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.secret',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});
