import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { UserRepository, userRepository, type UserWithRoles } from './user.repository.js';
import type { SafeUser, CreateUserData, UpdateUserData, PaginatedResult } from './user.types.js';

export function toSafeUser(user: UserWithRoles): SafeUser {
  const customUser = user as unknown as { isEmailVerified?: boolean; emailVerifiedAt?: Date | null };
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    roles: user.roles.map((r) => r.role.name),
    isEmailVerified: customUser.isEmailVerified ?? false,
    emailVerifiedAt: customUser.emailVerifiedAt ? customUser.emailVerifiedAt.toISOString() : null,
    deactivatedAt: user.deactivatedAt ? user.deactivatedAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export class UserService {
  private readonly repo: UserRepository;
  private readonly workFactor: number;

  constructor(repo: UserRepository = userRepository, workFactor: number = env.BCRYPT_WORK_FACTOR) {
    this.repo = repo;
    this.workFactor = workFactor;
  }

  /**
   * Normalizes an email address consistently across the application:
   * Strips whitespace and transforms to lowercase before storage or comparison.
   */
  public normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  public async createUser(input: CreateUserData): Promise<SafeUser> {
    const normalizedEmail = this.normalizeEmail(input.email);

    // Check duplicate email before hashing to avoid unnecessary CPU cost
    const existing = await this.repo.findByEmail(normalizedEmail);
    if (existing) {
      throw new HttpError(409, 'A user with this email address already exists');
    }

    // Safety guard against oversized password input
    if (Buffer.byteLength(input.password, 'utf8') > 72) {
      throw new HttpError(400, 'Password exceeds maximum length limit of 72 bytes');
    }

    const passwordHash = await bcrypt.hash(input.password, this.workFactor);

    try {
      const user = await this.repo.createUserWithRole(
        {
          email: normalizedEmail,
          passwordHash,
          displayName: input.displayName.trim(),
        },
        'USER',
      );

      return toSafeUser(user);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new HttpError(409, 'A user with this email address already exists');
      }
      throw err;
    }
  }

  public async listUsers(page: number, limit: number): Promise<PaginatedResult<SafeUser>> {
    const { users, total } = await this.repo.findMany(page, limit);
    const totalPages = Math.ceil(total / limit);

    return {
      data: users.map(toSafeUser),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  public async getUserById(id: string): Promise<SafeUser> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }
    return toSafeUser(user);
  }

  public async updateUserProfile(id: string, input: UpdateUserData): Promise<SafeUser> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    const updateData: { displayName?: string; email?: string } = {};

    if (input.displayName !== undefined) {
      updateData.displayName = input.displayName.trim();
    }

    if (input.email !== undefined) {
      const normalizedEmail = this.normalizeEmail(input.email);
      if (normalizedEmail !== user.email) {
        const existing = await this.repo.findByEmail(normalizedEmail);
        if (existing && existing.id !== id) {
          throw new HttpError(409, 'A user with this email address already exists');
        }
        updateData.email = normalizedEmail;
      }
    }

    try {
      const updated = await this.repo.updateProfile(id, updateData);
      return toSafeUser(updated);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new HttpError(409, 'A user with this email address already exists');
      }
      throw err;
    }
  }

  public async deactivateUser(id: string): Promise<SafeUser> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    // Idempotent deactivation: if already deactivated, return current state
    if (user.status === 'DEACTIVATED') {
      return toSafeUser(user);
    }

    const deactivated = await this.repo.deactivateUser(id);
    return toSafeUser(deactivated);
  }
}

export const userService = new UserService();
