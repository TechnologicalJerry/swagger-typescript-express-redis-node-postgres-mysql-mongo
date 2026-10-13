import { describe, it, expect } from 'vitest';
import { closeConnections } from '../src/server.js';

describe('Graceful shutdown connections cleanup', () => {
  it('safely closes all database connections without throwing', async () => {
    await expect(closeConnections()).resolves.toBeUndefined();
  });
});
