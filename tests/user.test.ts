import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { postgresDb } from '../src/db/postgres/client.js';
import { userRepository } from '../src/modules/user/user.repository.js';
import { userService } from '../src/modules/user/user.service.js';

describe('User Management Module', () => {
  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const otherUserId = 'b0000000-0000-0000-0000-000000000002';

  const cleanTestUsers = async () => {
    await postgresDb.user.deleteMany({
      where: {
        email: {
          contains: 'test',
        },
      },
    });
  };

  beforeEach(async () => {
    await cleanTestUsers();
  });

  afterAll(async () => {
    await cleanTestUsers();
  });

  describe('User Creation (POST /api/users)', () => {
    it('creates a user with valid details and default USER role', async () => {
      const res = await request(app).post('/api/users').send({
        displayName: 'Alice Cooper',
        email: 'alice.test@example.com',
        password: 'Password123!',
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.displayName).toBe('Alice Cooper');
      expect(res.body.email).toBe('alice.test@example.com');
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.roles).toEqual(['USER']);
      expect(res.body.deactivatedAt).toBeNull();
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('normalizes email addresses by trimming and lowercasing', async () => {
      const res = await request(app).post('/api/users').send({
        displayName: 'Bob Dylan',
        email: '   BOB.TEST@EXAMPLE.COM   ',
        password: 'Password123!',
      });

      expect(res.status).toBe(201);
      expect(res.body.email).toBe('bob.test@example.com');
    });

    it('rejects registration with duplicate email regardless of casing', async () => {
      await request(app).post('/api/users').send({
        displayName: 'First User',
        email: 'duplicate.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app).post('/api/users').send({
        displayName: 'Second User',
        email: 'DUPLICATE.TEST@EXAMPLE.COM',
        password: 'Password456!',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('already exists');
    });

    it('rejects invalid email formats', async () => {
      const res = await request(app).post('/api/users').send({
        displayName: 'Invalid Email User',
        email: 'not-an-email',
        password: 'Password123!',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Invalid email address');
    });

    it('rejects missing required fields', async () => {
      const res = await request(app).post('/api/users').send({
        displayName: 'No Password User',
        email: 'nopass.test@example.com',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Validation failed');
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const res = await request(app).post('/api/users').send({
        displayName: 'Short Password User',
        email: 'short.test@example.com',
        password: 'short',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('at least 8 characters');
    });

    it('rejects passwords exceeding 72 characters', async () => {
      const res = await request(app)
        .post('/api/users')
        .send({
          displayName: 'Long Password User',
          email: 'long.test@example.com',
          password: 'A'.repeat(73),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('cannot exceed 72 characters');
    });

    it('prevents privilege escalation when client supplies role or status', async () => {
      const res = await request(app)
        .post('/api/users')
        .send({
          displayName: 'Hacker User',
          email: 'hacker.test@example.com',
          password: 'Password123!',
          role: 'ADMIN',
          roles: ['ADMIN'],
          status: 'ADMIN',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Validation failed');
    });
  });

  describe('User Retrieval (GET /api/users/:id)', () => {
    it('retrieves user details when authorized as the user', async () => {
      const created = await userService.createUser({
        displayName: 'Charlie Brown',
        email: 'charlie.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .get(`/api/users/${created.id}`)
        .set('x-user-id', created.id)
        .set('x-user-role', 'USER');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.id);
      expect(res.body.email).toBe('charlie.test@example.com');
      expect(res.body.displayName).toBe('Charlie Brown');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('allows an administrator to retrieve any user profile', async () => {
      const created = await userService.createUser({
        displayName: 'Dana White',
        email: 'dana.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .get(`/api/users/${created.id}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.id);
    });

    it('forbids a regular user from retrieving another user profile', async () => {
      const created = await userService.createUser({
        displayName: 'Secret User',
        email: 'secret.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .get(`/api/users/${created.id}`)
        .set('x-user-id', otherUserId)
        .set('x-user-role', 'USER');

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Forbidden');
    });

    it('returns 404 for a non-existent user ID', async () => {
      const nonExistentUuid = 'a0000000-0000-4000-8000-000000000099';
      const res = await request(app)
        .get(`/api/users/${nonExistentUuid}`)
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('User not found');
    });

    it('returns 400 for an invalid UUID format', async () => {
      const res = await request(app)
        .get('/api/users/not-a-valid-uuid')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('must be a valid UUID');
    });
  });

  describe('User Listing and Pagination (GET /api/users)', () => {
    beforeEach(async () => {
      await userService.createUser({
        displayName: 'User 1',
        email: 'user1.test@example.com',
        password: 'Password123!',
      });
      await userService.createUser({
        displayName: 'User 2',
        email: 'user2.test@example.com',
        password: 'Password123!',
      });
      await userService.createUser({
        displayName: 'User 3',
        email: 'user3.test@example.com',
        password: 'Password123!',
      });
    });

    it('rejects unauthorized or non-admin callers', async () => {
      const noAuthRes = await request(app).get('/api/users');
      expect(noAuthRes.status).toBe(401);

      const userRoleRes = await request(app)
        .get('/api/users')
        .set('x-user-id', otherUserId)
        .set('x-user-role', 'USER');
      expect(userRoleRes.status).toBe(403);
    });

    it('returns paginated list for administrator with metadata', async () => {
      const res = await request(app)
        .get('/api/users?page=1&limit=2')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.pagination).toMatchObject({
        page: 1,
        limit: 2,
      });
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(3);
      expect(res.body.pagination.totalPages).toBeGreaterThanOrEqual(2);
    });

    it('rejects page size exceeding maximum of 100', async () => {
      const res = await request(app)
        .get('/api/users?limit=101')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('cannot exceed 100');
    });

    it('rejects invalid pagination parameters', async () => {
      const res = await request(app)
        .get('/api/users?page=0')
        .set('x-user-id', adminId)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Page must be at least 1');
    });
  });

  describe('User Profile Updates (PATCH /api/users/:id)', () => {
    it('allows a user to update their own display name', async () => {
      const user = await userService.createUser({
        displayName: 'Original Name',
        email: 'update1.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER')
        .send({
          displayName: 'Updated Name',
        });

      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Updated Name');
      expect(res.body.email).toBe('update1.test@example.com');
    });

    it('normalizes updated email address', async () => {
      const user = await userService.createUser({
        displayName: 'Email Update User',
        email: 'original.email.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER')
        .send({
          email: '  NEW.EMAIL.TEST@EXAMPLE.COM  ',
        });

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('new.email.test@example.com');
    });

    it('rejects email updates that conflict with another user', async () => {
      await userService.createUser({
        displayName: 'Existing User',
        email: 'existing.test@example.com',
        password: 'Password123!',
      });

      const user = await userService.createUser({
        displayName: 'Updating User',
        email: 'updating.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER')
        .send({
          email: 'existing.test@example.com',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('already exists');
    });

    it('rejects attempted modification of protected fields via mass assignment', async () => {
      const user = await userService.createUser({
        displayName: 'Protected Field User',
        email: 'protected.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER')
        .send({
          role: 'ADMIN',
          status: 'DEACTIVATED',
          passwordHash: 'injected_hash',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Validation failed');
    });

    it('forbids a regular user from updating another user profile', async () => {
      const user = await userService.createUser({
        displayName: 'Target User',
        email: 'target.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}`)
        .set('x-user-id', otherUserId)
        .set('x-user-role', 'USER')
        .send({
          displayName: 'Malicious Update',
        });

      expect(res.status).toBe(403);
    });

    it('rejects an empty update body', async () => {
      const user = await userService.createUser({
        displayName: 'Empty Update User',
        email: 'empty.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('At least one field');
    });
  });

  describe('User Deactivation (PATCH /api/users/:id/deactivate)', () => {
    it('successfully deactivates user without deleting record', async () => {
      const user = await userService.createUser({
        displayName: 'Deactivate Me',
        email: 'deact.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}/deactivate`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('DEACTIVATED');
      expect(res.body.deactivatedAt).not.toBeNull();

      // Verify user record still exists in database
      const inDb = await userRepository.findById(user.id);
      expect(inDb).not.toBeNull();
      expect(inDb?.status).toBe('DEACTIVATED');
    });

    it('is idempotent on repeated deactivation calls', async () => {
      const user = await userService.createUser({
        displayName: 'Double Deactivate',
        email: 'double.deact.test@example.com',
        password: 'Password123!',
      });

      const res1 = await request(app)
        .patch(`/api/users/${user.id}/deactivate`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER');

      expect(res1.status).toBe(200);
      const firstTimestamp = res1.body.deactivatedAt;

      const res2 = await request(app)
        .patch(`/api/users/${user.id}/deactivate`)
        .set('x-user-id', user.id)
        .set('x-user-role', 'USER');

      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('DEACTIVATED');
      expect(res2.body.deactivatedAt).toBe(firstTimestamp);
    });

    it('forbids unauthorized users from deactivating another user', async () => {
      const user = await userService.createUser({
        displayName: 'Victim User',
        email: 'victim.test@example.com',
        password: 'Password123!',
      });

      const res = await request(app)
        .patch(`/api/users/${user.id}/deactivate`)
        .set('x-user-id', otherUserId)
        .set('x-user-role', 'USER');

      expect(res.status).toBe(403);
    });
  });

  describe('Database Transaction Rollback on Role Failure', () => {
    it('rolls back user creation if role assignment fails within transaction', async () => {
      const email = 'rollback.test@example.com';

      // Attempt to create user with an invalid role that causes transaction failure
      try {
        await postgresDb.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email,
              passwordHash: 'dummy_hash',
              displayName: 'Rollback User',
            },
          });

          // Deliberately trigger foreign key error by referencing non-existent role UUID
          await tx.userRole.create({
            data: {
              userId: user.id,
              roleId: '99999999-9999-9999-9999-999999999999',
            },
          });
        });
        expect.fail('Transaction should have failed');
      } catch (err: unknown) {
        expect(err).toBeDefined();
      }

      // Verify that user was NOT persisted due to atomic transaction rollback
      const found = await postgresDb.user.findUnique({
        where: { email },
      });
      expect(found).toBeNull();
    });
  });
});
