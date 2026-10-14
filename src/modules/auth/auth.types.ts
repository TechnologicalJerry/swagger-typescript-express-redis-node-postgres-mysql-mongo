export type TokenType = 'ACCESS' | 'REFRESH';

export interface TokenPayload {
  sub: string;
  iss: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  tokenType: TokenType;
  email: string;
  roles: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface SessionMetadata {
  userId: string;
  tokenId: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RefreshCredentials {
  refreshToken: string;
}

export interface LogoutCredentials {
  refreshToken?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: string[];
}
