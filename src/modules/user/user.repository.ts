import type { PrismaClient, User, Role, UserRole } from '../../db/postgres/generated/client.js';
import { postgresDb } from '../../db/postgres/client.js';

export type UserWithRoles = User & {
  roles: (UserRole & {
    role: Role;
  })[];
};

export class UserRepository {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = postgresDb) {
    this.db = db;
  }

  /**
   * Ensures essential roles exist in the database.
   */
  public async ensureRole(name: string, description?: string): Promise<Role> {
    return this.db.role.upsert({
      where: { name },
      update: {},
      create: { name, description },
    });
  }

  /**
   * Creates a user and assigns the specified role within an atomic transaction.
   * If role assignment fails, the user creation is rolled back.
   */
  public async createUserWithRole(
    data: { email: string; passwordHash: string; displayName: string },
    roleName: string = 'USER',
  ): Promise<UserWithRoles> {
    return this.db.$transaction(async (tx) => {
      // Find or create role inside transaction
      let role = await tx.role.findUnique({
        where: { name: roleName },
      });

      if (!role) {
        role = await tx.role.create({
          data: {
            name: roleName,
            description: roleName === 'ADMIN' ? 'Administrator' : 'Standard user',
          },
        });
      }

      // Create user
      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash: data.passwordHash,
          displayName: data.displayName,
          status: 'ACTIVE',
        },
      });

      // Assign role
      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
        },
      });

      // Return user with loaded roles
      const result = await tx.user.findUnique({
        where: { id: user.id },
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      });

      if (!result) {
        throw new Error('Failed to retrieve newly created user');
      }

      return result;
    });
  }

  public async findByEmail(email: string): Promise<UserWithRoles | null> {
    return this.db.user.findUnique({
      where: { email },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
  }

  public async findById(id: string): Promise<UserWithRoles | null> {
    return this.db.user.findUnique({
      where: { id },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
  }

  public async findMany(
    page: number,
    limit: number,
  ): Promise<{ users: UserWithRoles[]; total: number }> {
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      this.db.user.findMany({
        skip,
        take: limit,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      }),
      this.db.user.count(),
    ]);

    return { users, total };
  }

  public async updateProfile(
    id: string,
    data: { displayName?: string; email?: string },
  ): Promise<UserWithRoles> {
    return this.db.user.update({
      where: { id },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
  }

  public async deactivateUser(id: string): Promise<UserWithRoles> {
    return this.db.user.update({
      where: { id },
      data: {
        status: 'DEACTIVATED',
        deactivatedAt: new Date(),
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
  }

  public async updatePassword(id: string, passwordHash: string): Promise<UserWithRoles> {
    return this.db.user.update({
      where: { id },
      data: { passwordHash },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
  }

  public async markEmailVerified(id: string): Promise<UserWithRoles | null> {
    await this.db.$executeRaw`
      UPDATE "users"
      SET "is_email_verified" = true,
          "email_verified_at" = NOW(),
          "updated_at" = NOW()
      WHERE "id" = ${id}::uuid
    `;
    return this.findById(id);
  }
}

export const userRepository = new UserRepository();
