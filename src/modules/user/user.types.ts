export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DEACTIVATED';
  roles: string[];
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CreateUserData {
  email: string;
  password: string;
  displayName: string;
}

export interface UpdateUserData {
  displayName?: string;
  email?: string;
}
