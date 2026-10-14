# Redis Learning Backend

A learning-focused backend designed to demonstrate practical Redis concepts through production-grade APIs, automated tests, and direct database inspection using `redis-cli` and RedisInsight.

## Architecture & Data Store Ownership

The application connects to four distinct data stores, each with strict domain ownership:

- **PostgreSQL 18** (via Prisma ORM 7 & `@prisma/adapter-pg`):
  - Planned domain: Users, roles, and inventory.
  - Phase 2: User management, role assignment, and profile lifecycle.
- **MySQL 8.4** (via Prisma ORM 7 & `@prisma/adapter-mariadb`):
  - Planned domain: Product catalog.
- **MongoDB 8.0** (via Mongoose 9):
  - Planned domain: Audit logs and login history.
- **Redis 8.6** (via ioredis 5/6):
  - Planned domain: Cache, authentication sessions, counters, distributed locks, messaging, and background job queues.
- **Mailpit** (via `axllent/mailpit:v1.31`):
  - Local SMTP testing interface for subsequent phases.

---

## Technology Stack & Verified Versions

| Component            | Target / Requested              | Verified Stable Release           | Notes                                                   |
| :------------------- | :------------------------------ | :-------------------------------- | :------------------------------------------------------ |
| **Runtime**          | Node.js 24 LTS                  | `v24.19.0` (LTS)                  | Native ESM enabled (`type: "module"`)                   |
| **Package Manager**  | npm                             | `12.0.2`                          | Clean lockfile management                               |
| **Language**         | TypeScript 6 (or latest stable) | `6.0.3`                           | Strict configuration with `NodeNext` resolution         |
| **HTTP Framework**   | Express 5                       | `5.0.0` (`@types/express: 5.0.6`) | Modern Express with native async error routing          |
| **Configuration**    | Zod 4                           | `4.6.7`                           | Fail-fast validation with sanitized secret reporting    |
| **Password Hashing** | bcrypt                          | `6.0.0` (`@types/bcrypt: 6.0.0`)  | Configurable work factor (default 10)                   |
| **PostgreSQL**       | PostgreSQL 18                   | `postgres:18` (Docker)            | Volume mapped to `/var/lib/postgresql`                  |
| **MySQL**            | MySQL 8.4 LTS                   | `mysql:8.4` (Docker)              | Native `mysqladmin ping` health probe                   |
| **MongoDB**          | MongoDB 8.0                     | `mongo:8.0` (Docker)              | `mongosh --eval "db.adminCommand('ping')"` health probe |
| **Redis**            | Redis 8.6                       | `redis:8.6` (Docker)              | Runs `redis-server --requirepass` with health check     |
| **Email Testing**    | Mailpit                         | `axllent/mailpit:v1.31`           | Web UI on `8025`, SMTP on `1025`                        |
| **ORM (SQL)**        | Prisma ORM 7                    | `7.10.0`                          | Dual independent configurations & client generations    |
| **MongoDB ODM**      | Mongoose                        | `9.1.2`                           | Fully compatible with Node 24 and Mongo 8               |
| **Redis Client**     | ioredis                         | `5.6.0`                           | Reusable client with bounded timeouts and redacted logs |
| **Logging**          | Pino & pino-http                | `9.6.0` / `10.4.0`                | Structured JSON logs with automated secret masking      |
| **Security**         | Helmet & CORS                   | `8.0.0` / `2.8.5`                 | Production HTTP headers and origin constraints          |
| **Testing**          | Vitest & Supertest              | `3.2.7` / `7.0.0`                 | Fast in-memory unit & live integration tests            |
| **Code Quality**     | ESLint 9 & Prettier             | `9.21.0` / `3.5.0`                | Modern Flat Config (`eslint.config.js`)                 |

---

## User Management Module (Phase 2)

### Schema & Role Model (PostgreSQL)

The user management module persists data in PostgreSQL 18 via Prisma ORM 7:

- **`User` model** (`users` table):
  - `id`: UUID primary key (`@default(uuid()) @db.Uuid`).
  - `email`: Normalized unique string (`@unique`).
  - `password_hash`: bcrypt hash (never exposed in API responses).
  - `display_name`: User display name string.
  - `status`: Account lifecycle enum (`ACTIVE`, `DEACTIVATED`).
  - `deactivated_at`: Timestamp populated on deactivation.
  - `created_at` & `updated_at`: Automated timestamps.
- **`Role` model** (`roles` table):
  - `id`: UUID primary key.
  - `name`: Unique role name (`USER`, `ADMIN`).
  - `description`: Optional text description.
- **`UserRole` model** (`user_roles` join table):
  - `user_id` & `role_id`: Composite primary key `@@id([userId, roleId])`.
  - Cascades on deletion.

### Email Normalization Strategy

All email addresses are systematically trimmed of leading/trailing whitespace and converted to lowercase (`email.trim().toLowerCase()`) before storage and query lookup. Database uniqueness (`users_email_key`) strictly guarantees case-insensitive uniqueness without relying on database collation defaults.

### Password Security & Hashing

- Passwords are validated using Zod: minimum 8 characters, maximum 72 characters (due to bcrypt input length boundaries).
- Passwords are automatically hashed before persistence using `bcrypt.hash(password, workFactor)`.
- The work factor is configurable via `BCRYPT_WORK_FACTOR` (default `10`).
- Passwords and password hashes are never returned in API payloads, logged, or accepted via updates.

### Authorization & Security Boundaries

Phase 2 establishes clean route boundaries while preparing for Phase 3 JWT authentication:

- **Public**: `POST /api/users` (Registration) creates users with default `USER` role. Callers cannot self-assign `ADMIN` or alter account status.
- **User-Scoped or Administrative (`requireSelfOrAdmin`)**:
  - `GET /api/users/:id`
  - `PATCH /api/users/:id`
  - `PATCH /api/users/:id/deactivate`
    Users may only access or mutate their own account. Administrators (`role: ADMIN`) can manage any account.
- **Administrative (`requireAdmin`)**: `GET /api/users` (Paginated list).
- **Development/Test Auth Guard**: Callers simulate authenticated identities via `x-user-id` and `x-user-role` headers in development and test environments. In production, client-provided identity headers are strictly ignored and rejected to prevent spoofing before Phase 3 JWT tokens are introduced.

### API Endpoints

#### 1. Register User (Public)

`POST /api/users`

**Request Body:**

```json
{
  "displayName": "Alice Cooper",
  "email": "alice@example.com",
  "password": "SecurePassword123!"
}
```

**Response (201 Created):**

```json
{
  "id": "e5b32f22-3860-4b2a-bf35-86f2b7f75432",
  "email": "alice@example.com",
  "displayName": "Alice Cooper",
  "status": "ACTIVE",
  "roles": ["USER"],
  "deactivatedAt": null,
  "createdAt": "2026-10-14T14:50:39.710Z",
  "updatedAt": "2026-10-14T14:50:39.710Z"
}
```

#### 2. List Users (Admin Only)

`GET /api/users?page=1&limit=10`

**Headers:**
`x-user-id: <admin-uuid>`  
`x-user-role: ADMIN`

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "e5b32f22-3860-4b2a-bf35-86f2b7f75432",
      "email": "alice@example.com",
      "displayName": "Alice Cooper",
      "status": "ACTIVE",
      "roles": ["USER"],
      "deactivatedAt": null,
      "createdAt": "2026-10-14T14:50:39.710Z",
      "updatedAt": "2026-10-14T14:50:39.710Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

#### 3. Get User By ID (Self or Admin)

`GET /api/users/:id`

**Response (200 OK):**

```json
{
  "id": "e5b32f22-3860-4b2a-bf35-86f2b7f75432",
  "email": "alice@example.com",
  "displayName": "Alice Cooper",
  "status": "ACTIVE",
  "roles": ["USER"],
  "deactivatedAt": null,
  "createdAt": "2026-10-14T14:50:39.710Z",
  "updatedAt": "2026-10-14T14:50:39.710Z"
}
```

#### 4. Update Profile (Self or Admin)

`PATCH /api/users/:id`

**Request Body:**

```json
{
  "displayName": "Alice C. Cooper"
}
```

**Response (200 OK):** Safe user representation with updated attributes.

#### 5. Deactivate User (Self or Admin)

`PATCH /api/users/:id/deactivate`

**Behavior:** Idempotently sets `status: "DEACTIVATED"` and records `deactivated_at`. Records are never deleted. Repeated deactivations return the current state with the original deactivation timestamp.

---

## Authentication & Redis Refresh-Token Sessions (Phase 3)

### Overview & Architecture

Phase 3 introduces production-grade authentication combining stateless JWT access tokens with stateful, revocable refresh-token sessions managed in Redis 8:

- **PostgreSQL 18** remains the source of truth for user credentials, account status (`ACTIVE` vs. `DEACTIVATED`), and role definitions.
- **Redis 8.6** acts as the high-throughput, low-latency session store for refresh tokens.
- **Access Tokens**: Short-lived, stateless JWTs containing user claims (`sub`, `iss`, `aud`, `iat`, `exp`, `jti`, `tokenType: 'ACCESS'`, `email`, `roles`).
- **Refresh Tokens**: Cryptographically signed JWTs (`tokenType: 'REFRESH'`) paired with server-side session records in Redis, enabling instant revocation and rotation.

### JWT Claims and Lifetimes

All JWTs are signed with HMAC SHA-256 (`HS256`) and explicitly validated with restricted algorithms. Tokens feature separate configuration-driven lifespans:

| Claim | Type | Description |
| :--- | :--- | :--- |
| `sub` | `string` | User UUID |
| `iss` | `string` | Configured issuer (`JWT_ISSUER`, default `redis-learning-backend`) |
| `aud` | `string` | Configured audience (`JWT_AUDIENCE`, default `redis-learning-api`) |
| `jti` | `string` | Cryptographically random UUID uniquely identifying each token |
| `tokenType` | `string` | Explicit discriminator: `'ACCESS'` or `'REFRESH'` |
| `email` | `string` | User's normalized email |
| `roles` | `string[]` | Assigned user roles (e.g. `['USER']`) |
| `iat` | `number` | Unix timestamp of token issuance |
| `exp` | `number` | Unix timestamp of token expiration |

Token lifetimes are configured in seconds via environment variables:
- **Access Token TTL**: `JWT_ACCESS_EXPIRATION_SECONDS` (default: `900` / 15 minutes).
- **Refresh Token TTL**: `JWT_REFRESH_EXPIRATION_SECONDS` (default: `604800` / 7 days).

### Redis Refresh-Token Session Store

#### Redis Key Conventions & Cluster Slot Safety

Redis keys utilize Redis Cluster hash tags `{userId}` so that a user's session index and individual session records consistently map to the identical hash slot:

- **Individual Session Key**: `refresh:{userId}:{tokenId}` (Hash)
  - Example: `refresh:{a0000000-0000-4000-8000-000000000001}:c1111111-1111-4000-8000-111111111111`
- **User Session Index Key**: `user_sessions:{userId}` (Sorted Set `ZSET`)
  - Example: `user_sessions:{a0000000-0000-4000-8000-000000000001}`

#### Stored Session Metadata

Sessions are stored as Redis Hashes (`HSET`) containing only minimal, non-sensitive metadata:
- `userId`: User UUID.
- `tokenId`: Unique token identifier (`jti`).
- `createdAt`: ISO 8601 creation timestamp.
- `expiresAt`: ISO 8601 expiration timestamp.
- `userAgent`: Client user-agent string (optional).
- `ipAddress`: Client IP address (optional).

Raw refresh tokens, passwords, and signing secrets are **never** stored in Redis.

#### Redis Commands & Data Structures

- **`HSET` / `HGETALL`**: Stores and retrieves session metadata fields.
- **`EXPIRE`**: Applies TTL matching refresh token duration so expired keys automatically expire.
- **`ZADD`**: Adds `tokenId` to `user_sessions:{userId}` with the creation timestamp (`Date.now()`) as the score.
- **`ZRANGE`**: Scans active token IDs in chronological order to identify the oldest session for FIFO eviction.
- **`ZCARD`**: Inspects current active session count.
- **`ZREM`**: Prunes individual token IDs from the user's index upon rotation or revocation.
- **`DEL`**: Removes session keys from Redis.
- **`EVAL` (Lua Scripts)**: Executes atomic session registration, rotation, and revocation scripts to eliminate race conditions under concurrent requests.

### Two-Session Limit & Eviction Policy

Users are permitted a maximum of **2 active refresh sessions** (`MAX_ACTIVE_SESSIONS_PER_USER = 2`):
1. **FIFO Eviction**: When a user already has 2 active sessions and logs in on a third device, an atomic Lua script automatically prunes the oldest session (the member with the lowest score in `user_sessions:{userId}`), deletes its `refresh:{userId}:{oldTokenId}` key, and registers the new session.
2. **Stale Pruning**: The registration script automatically purges orphaned index entries whose session keys have expired in Redis.
3. **Replay Detection & Family Revocation**: If a client attempts to refresh using a token whose session is missing in Redis (e.g. an already-rotated token that was intercepted), the system flags a replay attack and **revokes all active sessions** for that user.

### Authentication Endpoints

#### 1. Login

`POST /api/auth/login`

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123!"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIs...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
      "tokenType": "Bearer",
      "expiresIn": 900
    },
    "user": {
      "id": "a0000000-0000-4000-8000-000000000001",
      "email": "user@example.com",
      "displayName": "Alice Cooper",
      "status": "ACTIVE",
      "roles": ["USER"],
      "deactivatedAt": null,
      "createdAt": "2026-10-14T12:00:00.000Z",
      "updatedAt": "2026-10-14T12:00:00.000Z"
    }
  }
}
```

#### 2. Refresh Token Rotation

`POST /api/auth/refresh`

**Request Body:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIs...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
      "tokenType": "Bearer",
      "expiresIn": 900
    }
  }
}
```

#### 3. Logout

`POST /api/auth/logout`

**Headers:** `Authorization: Bearer <accessToken>`  
**Request Body (optional):**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "Logged out successfully"
}
```

#### 4. Current User Profile

`GET /api/auth/me`

**Headers:** `Authorization: Bearer <accessToken>`  
**Response (200 OK):** Returns the authenticated caller's safe user profile.

### Security Limitations & Boundaries

- **Access-Token Revocation**: Access tokens are stateless JWTs. Revoking a refresh session in Redis prevents issuing new tokens, but existing access tokens remain valid until their expiration (`JWT_ACCESS_EXPIRATION_SECONDS`). Instant access-token invalidation via a Redis blacklist is deferred to **Phase 4**.
- **Rate Limiting**: Brute-force protection on `/api/auth/login` is deferred to Phase 4.
- **OTP & Password Reset**: Multi-factor authentication and email verification belong to subsequent phases.

---

## Prisma Migrations

Migrations are managed with named, reviewable migration files:

```bash
# Generate a new reviewable migration without applying it:
npx prisma migrate dev --create-only --name <migration_name> --config prisma/postgres/prisma.config.ts

# Apply pending migrations to the PostgreSQL database:
npx prisma migrate deploy --config prisma/postgres/prisma.config.ts

# Generate Prisma clients:
npm run prisma:generate
```

---

## Health and Readiness Endpoints

- `GET /health`: Liveness probe (HTTP 200).
- `GET /ready`: Readiness probe checking PostgreSQL, MySQL, MongoDB, and Redis connectivity within 3000ms bounded timeouts (HTTP 200 if ready, HTTP 503 if any dependency fails).

---

## Quality Gates & Verification Commands

```bash
# Type check without emitting
npm run typecheck

# Lint with ESLint 9 Flat Config
npm run lint

# Format verification with Prettier
npm run format:check

# Auto-format files
npm run format

# Run full Vitest automated test suite
npm test

# Build production bundle
npm run build
```

---

## Redis Inspection & Verification

Inspect Redis sessions and keys directly using `redis-cli`:

```bash
docker compose exec redis redis-cli -a redispassword PING
docker compose exec redis redis-cli -a redispassword KEYS "refresh:*"
docker compose exec redis redis-cli -a redispassword KEYS "user_sessions:*"
```

