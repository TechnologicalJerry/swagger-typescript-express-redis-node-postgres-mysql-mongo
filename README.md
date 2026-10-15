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

- **Access-Token Revocation**: In Phase 3, access tokens were stateless JWTs. In Phase 4, immediate access-token revocation is enforced via the Redis access-token blacklist.
- **Rate Limiting**: Brute-force protection on authentication endpoints is now enforced via Redis rate limiters.

---

## Access-Token Blacklist, OTP Verification & Redis Rate Limiting (Phase 4)

### Overview & Architecture

Phase 4 extends the authentication system with three critical Redis capabilities:
1. **Immediate Access-Token Blacklisting**: Revokes stateless JWT access tokens before their natural expiration.
2. **Cryptographic OTP Workflows**: Non-reversible HMAC-SHA256 verifiers in Redis for email verification and password reset, paired with email delivery via Nodemailer & Mailpit.
3. **Dual Rate-Limiting Engines**: Fixed-window (`INCR` + `EXPIRE`) and sliding-window (Sorted Sets `ZSET`) algorithms with atomic Lua execution and automatic `Retry-After` calculation.

---

### Feature A — Access-Token Blacklist

#### Key Design & TTL Lifecycle
- **Key Pattern**: `blacklist:access:{jti}` (Redis String)
- **Stored Value**: `"revoked"`
- **TTL Strategy**: Exactly equal to the remaining lifetime of the access token (`exp - nowSeconds`).
- **Optimization**: Tokens that are already expired are rejected by JWT validation without creating redundant blacklist entries in Redis.

#### Enforcement & Middleware Integration
- On every protected request, `authenticate` middleware verifies JWT claims and queries Redis:
  ```bash
  EXISTS blacklist:access:{jti}
  ```
- If the key exists, the request is immediately rejected with `401 Unauthorized` (`"Access token has been revoked"`).
- **Fail-Closed Resilience**: If Redis is unreachable, the check throws an HTTP 500 error, refusing to allow potentially revoked tokens to execute operations.

#### Logout Integration
- Calling `POST /api/auth/logout` simultaneously:
  1. Revokes the caller's active refresh session(s) in Redis via `SessionService`.
  2. Adds the current access token's `jti` to the Redis blacklist via `TokenBlacklistService`.
- **Idempotence**: Repeated logout calls with the same token return `200 OK` safely.

---

### Feature B — OTP Email Verification & Password Reset

#### Cryptographic Generation & Non-Reversible Storage
- **Generation**: Cryptographically secure numeric codes (`crypto.randomInt`) of configurable length (`OTP_LENGTH`, default 6 digits).
- **Secure Verifier**: Plaintext OTPs are **never** stored in Redis. Instead, a non-reversible HMAC-SHA256 verifier is computed using a dedicated server secret (`OTP_SECRET`):
  $$\text{verifier} = \text{HMAC-SHA256}(\text{OTP\_SECRET}, \text{userId} + ":" + \text{purpose} + ":" + \text{otp})$$
- **Cluster Slot Affinity**: All OTP keys for a given user utilize the `{userId}` hash tag:
  - `otp:{userId}:email-verification` — Stored HMAC verifier (TTL: `OTP_EXPIRATION_SECONDS`, default 300s).
  - `otp:{userId}:password-reset` — Stored HMAC verifier (TTL: `OTP_EXPIRATION_SECONDS`, default 300s).
  - `otp:{userId}:cooldown:{purpose}` — Cooldown key (TTL: `OTP_COOLDOWN_SECONDS`, default 60s).
  - `otp:{userId}:attempts:{purpose}` — Attempt counter (TTL: `OTP_EXPIRATION_SECONDS`, max 3 attempts).

#### Atomic Verify-and-Consume (`VERIFY_AND_CONSUME_OTP_LUA`)
- An atomic Lua script verifies the submitted verifier, enforces attempt limits, and consumes the OTP:
  - If attempts $\ge$ max attempts: deletes OTP key, returns `-2` (`MAX_ATTEMPTS_EXCEEDED`).
  - If OTP expired or missing: returns `-1` (`EXPIRED_OR_NOT_FOUND`).
  - If verifier matches: deletes OTP and attempts keys atomically, returns `1` (`SUCCESS`).
  - If verifier mismatches: increments attempt counter, returns `0` (`INVALID_OTP`).
- **Replay Protection**: The one-time code is deleted atomically upon verification, making reuse impossible.

#### Email Delivery via Mailpit
- Emails are dispatched using Nodemailer to the local Mailpit container (`SMTP_HOST=localhost`, `SMTP_PORT=1025`).
- The Mailpit web UI can be viewed at `http://localhost:8025`.
- OTP codes are never logged to console or included in API responses.

#### OTP Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/email-verification/request` | Requests verification code. Returns generic message to prevent account enumeration. |
| `POST` | `/api/auth/email-verification/verify` | Atomically verifies OTP and marks `is_email_verified = true` in PostgreSQL. |
| `POST` | `/api/auth/password-reset/request` | Requests password reset code. Returns generic response. |
| `POST` | `/api/auth/password-reset/verify` | Atomically verifies OTP, hashes new password with bcrypt, updates PostgreSQL, and revokes all active refresh sessions. |

---

### Features C & D — Dual Rate-Limiting Engines

Both algorithms are implemented as atomic Redis Lua scripts and exposed through reusable middleware:

#### 1. Feature C — Fixed-Window Rate Limiter (`INCR` + `EXPIRE`)
- **Key Pattern**: `rate:fixed:{policy}:{clientKey}` (Redis String counter)
- **Algorithm**:
  - `INCR key` increments request count.
  - If `count == 1`, `EXPIRE key windowSeconds` assigns the TTL atomically.
  - Evaluates if `count <= maxRequests`.
- **Characteristics**: Simple and memory-efficient; best for general API endpoints.

#### 2. Feature D — Sliding-Window Rate Limiter (Sorted Sets `ZSET`)
- **Key Pattern**: `rate:sliding:{policy}:{clientKey}` (Redis Sorted Set)
- **Algorithm**:
  - `ZREMRANGEBYSCORE key -inf (nowMs - windowMs)` prunes timestamps outside the active window.
  - `ZCARD key` counts requests remaining in the active window.
  - If under limit: records new request with `ZADD key nowMs memberId` and refreshes key TTL.
  - If over limit: retrieves the oldest timestamp via `ZRANGE key 0 0 WITHSCORES` to calculate the exact `Retry-After` seconds.
- **Characteristics**: Perfectly smooth rate limiting without boundary-burst vulnerabilities; used for sensitive auth and OTP endpoints.

#### Client Identity & Express Proxy Trust
- Client keys are resolved using `req.ip` (normalized IPv4/IPv6).
- `app.set('trust proxy', 1)` is enabled in Express, safely extracting the client IP from the first upstream reverse proxy while preventing forged `X-Forwarded-For` spoofing.

#### Response Headers & Error Format
When a rate limit is evaluated, standard headers are returned:
- `X-RateLimit-Limit`: Maximum requests permitted in the window.
- `X-RateLimit-Remaining`: Remaining request quota.
- `Retry-After`: Seconds to wait before retrying (on HTTP 429).

On rejection:
```json
{
  "error": {
    "message": "Too many requests. Please try again later.",
    "statusCode": 429
  }
}
```

---

### Redis Key Patterns Introduced in Phase 4

| Pattern | Redis Data Type | TTL Policy | Cleanup Behavior |
| :--- | :--- | :--- | :--- |
| `blacklist:access:{jti}` | String | Remaining token lifetime (`exp - now`) | Automatically expires when access token expires |
| `otp:{userId}:email-verification` | String | Configurable (`OTP_EXPIRATION_SECONDS`, default 300s) | Deleted atomically on successful verification or max attempts |
| `otp:{userId}:password-reset` | String | Configurable (`OTP_EXPIRATION_SECONDS`, default 300s) | Deleted atomically on successful verification or max attempts |
| `otp:{userId}:cooldown:{purpose}` | String | Configurable (`OTP_COOLDOWN_SECONDS`, default 60s) | Automatically expires after cooldown duration |
| `otp:{userId}:attempts:{purpose}` | String (counter) | Matches OTP expiration | Deleted on successful verification or expires with OTP |
| `rate:fixed:{policy}:{clientKey}` | String (counter) | Fixed window seconds (`windowSeconds`) | Automatically expires at end of fixed window |
| `rate:sliding:{policy}:{clientKey}` | Sorted Set (`ZSET`) | `windowSeconds + 10s` buffer | Old entries pruned on each request; key expires when inactive |

---

## Product Management & Redis Cache-Aside (Phase 5)

### Architecture & Data Store Roles
- **MySQL 8.4** (via Prisma ORM 7 & `@prisma/adapter-mariadb`): The authoritative source of truth for product data.
- **Redis 8.6** (via `ioredis`): Ephemeral caching layer operating under the **Cache-Aside** (Lazy Loading) pattern with **Cache-Stampede** protection.

### Product Data Model (MySQL)
The product catalog persists in MySQL 8.4 using Prisma ORM 7:
- **`Product` model** (`products` table):
  - `id`: UUID primary key (`CHAR(36)` / `@default(uuid())`).
  - `name`: Product name string (`VARCHAR(255)`).
  - `slug`: URL-friendly identifier string (`VARCHAR(255)`), enforced unique via `products_slug_key`.
  - `description`: Optional text description (`TEXT`).
  - `price`: Strict monetary value representation (`DECIMAL(10, 2)`), preventing floating-point inaccuracies. Mapped to string in API DTOs.
  - `currency`: ISO 4217 currency code (`CHAR(3)`, default `'USD'`).
  - `sku`: Stock Keeping Unit string (`VARCHAR(64)`), enforced unique via `products_sku_key`.
  - `category`: Product category classification (`VARCHAR(100)`), indexed for filtering.
  - `isActive`: Boolean status flag (`BOOLEAN`, default `true`), indexed for active/inactive queries.
  - `createdAt` & `updatedAt`: Automated timestamps (`DATETIME(3)`).
- **Indexes**:
  - `products_category_idx` on `(category)`.
  - `products_is_active_idx` on `(isActive)`.
  - `products_created_at_idx` on `(createdAt)`.

### Redis Cache-Aside Pattern
Individual product lookups (`GET /api/products/:id`) follow the Cache-Aside pattern:
1. Client requests a product by ID.
2. The application checks Redis for the key `cache:product:{productId}`.
3. **Cache Hit**: If found, JSON deserializes the payload, sets header `X-Cache: HIT`, and returns immediately without querying MySQL.
4. **Cache Miss**: If key is absent, the cache stampede coordination mechanism activates (see below). The winning request retrieves the product from MySQL.
5. If the product exists in MySQL, it is serialized to JSON and stored in Redis with an automatic TTL (`PRODUCT_CACHE_TTL_SECONDS`, default 300s).
6. Sets header `X-Cache: MISS` and returns the product.
7. If the product does not exist in MySQL, an HTTP 404 is returned consistently without fabricating data.

#### Corrupted JSON Recovery
If invalid or malformed JSON is encountered in a Redis cache entry, the service:
- Logs the error with structured context.
- Purges the corrupted Redis key atomically via `DEL`.
- Gracefully treats the condition as a cache miss, re-fetching the authoritative record from MySQL and re-populating Redis.

### Cached Product List Strategy
Paginated list queries (`GET /api/products`) use query-fingerprinted caching:
- **Fingerprinting**: Normalized query parameters (`page`, `limit`, lowercase `category`, `isActive`, lowercase `search`) are hashed into a deterministic 16-character SHA-256 hex fingerprint.
- **Key Pattern**: `cache:product:list:{fingerprint}` (Redis String).
- **TTL**: Shorter TTL (`PRODUCT_LIST_CACHE_TTL_SECONDS`, default 60s) to balance freshness with query load reduction.
- **Non-Wildcard Invalidation Index**: Every active list key is registered in a Redis Set at `cache:product:list_keys`. On product mutation, `SMEMBERS` retrieves the tracked list keys, and a Redis pipeline deletes them in batch. This avoids dangerous, blocking `KEYS *` or keyspace scan operations.

### Observable Cache Behavior (`X-Cache` Header)
Every product read endpoint emits an observable `X-Cache` response header:
- `HIT`: The request was fulfilled directly from a valid Redis cache entry.
- `MISS`: The cache key was missing or expired; data was retrieved from MySQL and stored in Redis.
- `BYPASS`: Caching was deliberately skipped. This occurs when:
  - The client provides `Cache-Control: no-cache` or `X-Skip-Cache: true`.
  - Redis connection is unavailable or degraded (graceful fallback to MySQL without service outage).

### Cache Invalidation Strategy
- **MySQL First**: MySQL is always updated or deleted before Redis cache invalidation occurs. Redis is never updated first under the assumption that the database write will succeed.
- **Post-Mutation Purge**: Upon successful MySQL write:
  - `cache:product:{productId}` is deleted.
  - All tracked list cache keys in `cache:product:list_keys` are purged.
- **Rollback Safety**: If the MySQL write fails or validation rejects the input, cache invalidation is aborted, leaving valid cache entries intact.
- **Invalidation Failure Logging**: If MySQL succeeds but Redis invalidation fails, the issue is logged at ERROR level without claiming false cache freshness, documenting the temporary consistency window bounded by the cache TTL.

### Cache-Stampede Protection (Distributed Lock)
To protect MySQL against concurrent read spikes when a popular product cache entry expires:
- **Lock Key**: `lock:cache:product:{productId}`
- **Acquisition**: `SET lock:cache:product:{productId} <uuid_token> PX 2000 NX` (expires in 2000ms).
- **Behavior**:
  - The single request that acquires the lock queries MySQL and repopulates Redis.
  - Concurrent requests that fail to acquire the lock do not storm MySQL. Instead, they enter a bounded wait loop (up to 3 retries, 50ms intervals) to read the newly populated cache.
  - If the lock holder fails or takes too long, waiting requests safely fall back to MySQL.
- **Atomic Lua Release**: Locks are released using a compare-and-delete Lua script, guaranteeing that a request only releases a lock if it still owns the unique token:
  ```lua
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
  ```

### Redis Failure and Data Consistency
- Redis acts as a performance optimization, not an authoritative datastore.
- If Redis is down, disconnected, or returns an error, the application falls back gracefully to MySQL with `X-Cache: BYPASS`.
- Read operations never fail solely because Redis is offline.

---

### Redis Key Patterns Introduced in Phase 5

| Pattern | Redis Data Type | TTL Policy | Cleanup Behavior |
| :--- | :--- | :--- | :--- |
| `cache:product:{productId}` | String (JSON) | `PRODUCT_CACHE_TTL_SECONDS` (300s) | Deleted on product update/delete, or expires automatically |
| `cache:product:list:{fingerprint}` | String (JSON) | `PRODUCT_LIST_CACHE_TTL_SECONDS` (60s) | Deleted on product create/update/delete via tracked set |
| `cache:product:list_keys` | Set (`SET`) | 2x `PRODUCT_LIST_CACHE_TTL_SECONDS` (120s) | Deleted when list caches are invalidated on mutation |
| `lock:cache:product:{productId}` | String (UUID token) | `PRODUCT_CACHE_LOCK_TTL_MS` (2000ms) | Released atomically via Lua compare-and-delete, or auto-expires |

---

### Product API Endpoints

| Method | Endpoint | Access | Cache Header | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/products` | ADMIN only | N/A | Creates product in MySQL; invalidates list caches. |
| `GET` | `/api/products` | Public | `X-Cache: HIT \| MISS \| BYPASS` | Lists products with bounded pagination and query-fingerprinted cache. |
| `GET` | `/api/products/trending` | Public | N/A | Lists trending products ranked by popularity score in descending order. |
| `GET` | `/api/products/:id` | Public | `X-Cache: HIT \| MISS \| BYPASS` | Retrieves product by ID using cache-aside and counts qualifying views. |
| `GET` | `/api/products/:id/analytics` | Public | N/A | Retrieves total views, estimated unique viewers (HLL), and trending score. |
| `PATCH` | `/api/products/:id` | ADMIN only | N/A | Updates product in MySQL; invalidates product and list caches. |
| `DELETE` | `/api/products/:id` | ADMIN only | N/A | Deletes product in MySQL; invalidates caches and cleans up analytics keys. |

---

## Product View Counters, Trending Leaderboard & HyperLogLog (Phase 6)

### High-Throughput View Counting (Redis String `INCR`)
- **Key Pattern**: `views:product:{productId}` (Redis String integer counter).
- **Why Redis**: High-traffic products can experience thousands of views per minute. Writing every view directly to relational storage (MySQL) introduces row-level locking bottlenecks and disk I/O contention. Redis `INCR` executes entirely in-memory with sub-millisecond atomic latency.
- **Qualifying View Definition**:
  - The request targets `GET /api/products/:id` and successfully resolves an active product (`product !== null && product.isActive === true`).
  - The caller is **not an administrator** (`req.user?.role !== 'ADMIN'`), excluding internal curation, catalog management, and automated health checks from inflating public metrics.
  - Excludes 404 not-found queries.
- **Asynchronous & Non-Blocking**: View recording runs asynchronously in the background and never blocks or delays the HTTP response.
- **Active Set Tracking**: Whenever a counter is incremented, the product UUID is registered in a Redis Set (`views:active_products`). This allows the aggregation job to discover counters without scanning the full keyspace with `KEYS *`.

---

### Periodic Counter Aggregation into MySQL
To ensure analytics survive Redis counter resets and can be queried historically, unaggregated view counts are periodically drained and persisted into MySQL.

#### 1. Correctness & Atomic Counter Drain (Lua Script)
A naive `GET` followed by `DEL` suffers from race conditions: any concurrent `INCR` arriving between the two operations would be permanently lost. To guarantee zero loss of incoming views:
- An **atomic Lua script** executes within Redis:
  - Takes up to `batchSize` product IDs from `views:active_products`.
  - For each product, drains the counter via `GET` + `DEL` atomically within the script.
  - Moves the drained counts directly into a uniquely identified pending batch Hash: `views:pending_batch:{batchId}`.
  - Registers `batchId` in the set `views:pending_batches`.
  - Removes the drained products from `views:active_products`.
- Any views arriving after the atomic drain initialize a fresh counter starting from 1 and re-register in `views:active_products`.

#### 2. Durable Pending-Batch Recovery Protocol
Because Redis and MySQL do not share a distributed transaction, an aggregation crash or MySQL outage after draining Redis must not lose counts:
- The drained batch is held durably in `views:pending_batch:{batchId}`.
- On each scheduler cycle, the aggregation service inspects `views:pending_batches` for unacknowledged batches from previous failed runs and retries persisting them before processing new counters.

#### 3. Idempotent MySQL Persistence (Exactly-Once Effect)
- A dedicated MySQL table `processed_aggregation_batches` tracks completed batch IDs.
- In a single MySQL database transaction:
  1. Checks if `batchId` is already present in `processed_aggregation_batches`. If yes, commits immediately without re-applying increments.
  2. Inserts `batchId` into `processed_aggregation_batches`.
  3. Atomically upserts each product increment into `product_statistics`:
     ```sql
     INSERT INTO product_statistics (product_id, total_views, last_aggregated_at, created_at, updated_at)
     VALUES (?, ?, NOW(3), NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       total_views = total_views + VALUES(total_views),
       last_aggregated_at = VALUES(last_aggregated_at),
       updated_at = NOW(3);
     ```
- Only after MySQL successfully commits the transaction is the pending batch acknowledged and purged from Redis (`DEL views:pending_batch:{batchId}` and `SREM views:pending_batches {batchId}`).

#### 4. Scheduler & Distributed Concurrency Coordination
- Configured via `PRODUCT_VIEW_AGGREGATION_INTERVAL_MS` (default 60,000ms / 1 min).
- **In-process guard**: An `isRunning` flag prevents overlapping executions within a single process.
- **Multi-instance coordination**: Acquires a short-lived Redis lock `lock:job:product-view-aggregation` (`SET NX PX 30000`) before running, ensuring that multiple deployed containers do not execute simultaneous aggregations.

---

### Trending Products Leaderboard (Redis Sorted Set `ZSET`)
- **Key Pattern**: `trending:products` (Redis Sorted Set).
- **Scoring Strategy**: Cumulative popularity leaderboard where 1 qualifying view increments the product's score by 1 via `ZINCRBY trending:products 1 {productId}`.
- **Why Sorted Sets**: Maintains member-score pairs with real-time $O(\log N)$ insertion and ranking. Querying the top $K$ trending products via `ZREVRANGE` requires $O(\log N + K)$ operations, avoiding costly MySQL table scans and `ORDER BY` operations.
- **Endpoint**: `GET /api/products/trending?limit=10`
  - Validates `limit` parameter (bounded between 1 and 100).
  - Retrieves top product IDs and scores in descending order.
  - Enriches results with full product details from the existing product cache / repository.
  - Handles deleted or inactive products: if a product is inactive or removed from MySQL, it is omitted from the public response and pruned from the leaderboard via `ZREM`.
- **Response Structure**:
  ```json
  {
    "data": [
      {
        "product": { "id": "...", "name": "...", "price": "..." },
        "score": 42,
        "rank": 1
      }
    ],
    "total": 1
  }
  ```

---

### HyperLogLog for Approximate Unique Viewers
- **Key Pattern**: `views:unique:product:{productId}` (HyperLogLog).
- **How It Works**:
  - HyperLogLog estimates cardinality using a probabilistic algorithm with a fixed memory footprint of **12 KB per key**, achieving a typical standard error of ~0.81%.
  - `PFADD` registers elements.
  - `PFCOUNT` queries the estimated unique count.
- **Privacy-Conscious Viewer Token Design**:
  - To respect user privacy and avoid storing raw personally identifiable information (PII) or IP addresses in Redis, the service generates a pseudonymous one-way HMAC token:
    - **Authenticated users**: `HMAC_SHA256(userId, VIEWER_HMAC_SECRET)`
    - **Anonymous users**: `HMAC_SHA256(clientIp + ":" + userAgent, VIEWER_HMAC_SECRET)`
  - Raw emails, user IDs, passwords, and IP addresses are **never stored** in HyperLogLog registers.
- **Limitations & Transparency**:
  - HyperLogLog does not retain member lists; individual viewers cannot be queried or enumerated.
  - It is an estimation, not an exact count.
  - The analytics endpoint explicitly flags `isEstimate: true` and labels the field `estimatedUniqueViewers`.

---

### Redis Key Patterns Introduced in Phase 6

| Pattern | Redis Data Type | TTL Policy | Cleanup Behavior |
| :--- | :--- | :--- | :--- |
| `views:product:{productId}` | String (Counter) | No TTL (durable unaggregated delta) | Atomically drained and deleted by periodic aggregation job |
| `views:active_products` | Set (`SET`) | No TTL (active index) | Members removed as counters are drained during aggregation |
| `views:pending_batch:{batchId}` | Hash (`HSET`) | 24 Hours (`EXPIRE 86400`) safeguard | Deleted immediately upon successful MySQL transaction commit |
| `views:pending_batches` | Set (`SET`) | No TTL (batch tracking) | Members removed as pending batches are acknowledged |
| `trending:products` | Sorted Set (`ZSET`) | No TTL (cumulative popularity) | Pruned via `ZREM` when products are deactivated or deleted |
| `views:unique:product:{productId}` | HyperLogLog (`HLL`) | No TTL (cumulative cardinality) | Deleted via `DEL` when target product is deleted |
| `lock:job:product-view-aggregation` | String (Lock token) | 30 Seconds (`PX 30000`) | Released atomically via Lua compare-and-delete on job finish |

---

## Inventory Management & Atomic Stock Operations (Phase 7)

### Architecture & Database Ownership
- **PostgreSQL 18** (via Prisma ORM 7 & `@prisma/adapter-pg`): The authoritative source of truth for inventory balances and stock transactions.
- **MySQL 8.4** (via Prisma ORM 7 & `@prisma/adapter-mariadb`): The authoritative product catalog. Referenced products must exist in MySQL before inventory records can be created in PostgreSQL. Cross-database validation runs at the application service boundary.
- **Redis 8.6** (via `ioredis`): Ephemeral atomic stock reservation demonstration via single-threaded Lua script.

---

### Stock Quantity Semantics
To prevent semantic ambiguities across the database, APIs, and Redis scripts, inventory uses three strictly defined metrics:
1. **Physical Stock (`quantity`)**: Total physical inventory units in the warehouse.
2. **Reserved Stock (`reservedQuantity`)**: Units allocated or held for unfulfilled orders or pending checkout. Must satisfy:
   $$0 \le \text{reservedQuantity} \le \text{quantity}$$
3. **Available Stock (`availableQuantity`)**: Free stock eligible for allocation or immediate purchase:
   $$\text{availableQuantity} = \text{quantity} - \text{reservedQuantity}$$
4. **Stock Decrement**: Permanently deducts physical inventory (`quantity = quantity - amount`). Requires $\text{availableQuantity} \ge \text{amount}$.
5. **Stock Reservation**: Temporarily allocates stock (`reservedQuantity = reservedQuantity + amount`), leaving physical `quantity` unchanged. Requires $\text{availableQuantity} \ge \text{amount}$.
6. **Stock Adjustment**: Administrative modification of physical stock (e.g. warehouse restocking). Rejects adjustments where $\text{newQuantity} < \text{reservedQuantity}$.

---

### PostgreSQL Inventory Data Model
Stored in the `inventories` table in PostgreSQL 18:
- `id`: UUID primary key (`gen_random_uuid()`).
- `product_id`: Unique string identifier (`VARCHAR(36)`), indexed and enforced unique (1:1 mapping per product).
- `quantity`: Non-negative integer physical stock.
- `reserved_quantity`: Non-negative integer reserved stock.
- `created_at` & `updated_at`: Automated timestamps.
- **Database CHECK Constraints** (enforced in migration SQL):
  ```sql
  CONSTRAINT "chk_inventory_quantity_non_negative" CHECK ("quantity" >= 0),
  CONSTRAINT "chk_inventory_reserved_non_negative" CHECK ("reserved_quantity" >= 0),
  CONSTRAINT "chk_inventory_reserved_lte_quantity" CHECK ("reserved_quantity" <= "quantity")
  ```

---

### Authoritative PostgreSQL Concurrency Control

#### 1. Row-Level Locking (`SELECT ... FOR UPDATE`)
The primary decrement and reservation endpoints use PostgreSQL row-level locks within a transaction:
1. Begins a PostgreSQL interactive transaction (`postgresDb.$transaction`).
2. Executes parameterized query with row lock:
   ```sql
   SELECT id, product_id, quantity, reserved_quantity, created_at, updated_at
   FROM inventories
   WHERE product_id = $1
   FOR UPDATE
   ```
3. PostgreSQL acquires an exclusive row lock on the specific record. Concurrent transactions targeting the same row block until the current transaction completes.
4. Validates $\text{availableQuantity} \ge \text{amount}$. If insufficient, rolls back the transaction and returns HTTP `409 Conflict`.
5. Updates the record (`UPDATE inventories ...`) and commits the transaction.
6. Returns the updated authoritative inventory state.

#### 2. PostgreSQL Transaction-Scoped Advisory Locks (`pg_advisory_xact_lock`)
For architectural comparison, Phase 7 includes an alternative reservation path using PostgreSQL advisory locks:
- **How It Works**: `pg_advisory_xact_lock(hashtext(productId))` creates an application-defined mutex in PostgreSQL shared memory rather than acquiring a row lock on disk.
- **Deterministic Hashing**: `hashtext(productId)` hashes the UUID into a signed 32-bit integer.
- **Automatic Lifecycle**: The `_xact_` variant is transaction-scoped; locks are guaranteed to release upon `COMMIT` or `ROLLBACK`, eliminating orphan lock risks.
- **Comparison Table**:

| Feature | PostgreSQL Row-Level Lock (`SELECT FOR UPDATE`) | PostgreSQL Advisory Lock (`pg_advisory_xact_lock`) |
| :--- | :--- | :--- |
| **Lock Target** | Specific physical row on table disk page | Application integer identifier in PostgreSQL shared memory |
| **Row Prerequisite** | Row must exist before lock can be acquired | Can lock abstract resource *before* row creation |
| **Storage Overhead** | Modifies tuple header fields (`xmax`, `t_infomask`) | Managed in PostgreSQL shared memory lock table |
| **Deadlock Risk** | Potential if multiple rows acquired in inconsistent order | Low if deterministic single-hash ordering is used |

---

### Redis Lua Atomic Stock Reservation Demonstration
- **Key Pattern**: `stock:{productId}` (Redis String integer counter).
- **Atomic Lua Script**:
  - Validates key exists and contains a valid integer.
  - Validates requested amount is a positive integer.
  - Verifies $\text{currentStock} \ge \text{requestedAmount}$.
  - Atomically decrements stock via `DECRBY`.
  - Returns structured result `[1, remainingStock, "SUCCESS"]` or `[0, currentStock, "ERR_INSUFFICIENT_STOCK"]`.
- **Single-Threaded Atomicity**: Redis executes Lua scripts sequentially on a single thread. The read, sufficiency check, and decrement execute as a single atomic unit without race conditions, guaranteeing stock never drops below zero.
- **Safe Initialization (`SET NX`)**:
  - `SET stock:{productId} <availableQuantity> NX`
  - `NX` ensures concurrent initializers or active reservation counters are not accidentally overwritten.
  - If a Redis stock key is missing during reservation, it automatically initializes from PostgreSQL available stock and retries.
- **Consistency Boundaries**:
  - Redis and PostgreSQL do **not** participate in a two-phase commit (2PC).
  - The Redis reservation endpoint (`POST /api/inventory/:productId/reserve-redis`) is an isolated high-throughput demonstration.
  - PostgreSQL remains the authoritative source of truth.

---

### Redis Key Patterns Introduced in Phase 7

| Pattern | Redis Data Type | TTL Policy | Cleanup Behavior |
| :--- | :--- | :--- | :--- |
| `stock:{productId}` | String (Counter) | No TTL (active reservation counter) | Initialized via `SET NX`; deleted via `DEL` upon product deletion |

---

### Inventory API Endpoints

| Method | Endpoint | Access | Concurrency Mechanism | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/inventory` | ADMIN only | PostgreSQL Transaction | Creates inventory record for an existing MySQL product. |
| `GET` | `/api/inventory/:productId` | Public | PostgreSQL Read | Retrieves authoritative inventory quantities from PostgreSQL. |
| `PATCH` | `/api/inventory/:productId` | ADMIN only | `SELECT FOR UPDATE` | Adjusts physical stock quantity; rejects reduction below reserved stock. |
| `POST` | `/api/inventory/:productId/decrement` | Public | `SELECT FOR UPDATE` | Authoritative atomic stock decrement in PostgreSQL. |
| `POST` | `/api/inventory/:productId/reserve-postgres` | Public | `SELECT FOR UPDATE` or Advisory Lock | Authoritative stock reservation in PostgreSQL. |
| `POST` | `/api/inventory/:productId/reserve-redis` | Public | Redis Lua Atomic Script | Isolated Redis atomic stock reservation demonstration. |

---

## Reservation Holds with TTL and Distributed Locks (Phase 8)

### Overview & Ownership Model

Phase 8 implements temporary inventory reservation holds with TTLs, distributed lock coordination, and guaranteed durability:

- **PostgreSQL 18 (Authoritative Source of Truth)**:
  - Manages durable inventory records (`inventories` table) with non-negative constraints on physical `quantity` and `reserved_quantity`.
  - Manages durable reservation records (`reservations` table) tracking lifecycle status (`PENDING`, `CONFIRMED`, `CANCELLED`, `EXPIRED`), timestamps, and unique idempotency keys.
  - Database row-level locks (`SELECT ... FOR UPDATE`) and ACID transactions guarantee that stock is never oversold or double-allocated under concurrent bursts.
- **Redis 8.6 (Temporary Hold State & Coordination)**:
  - Caches fast-lookup hold metadata (`reservation:{reservationId}`).
  - Tracks expiration deadlines in a Sorted Set index (`reservation:expiry`) for bounded background recovery.
  - Provides fast-path idempotency checks (`reservation:idempotency:{idempotencyKey}`).
  - Coordinates multi-worker mutations using atomic distributed locks (`lock:reservation:{reservationId}`).
- **Cross-Store Consistency Boundaries**:
  - Redis and PostgreSQL do **not** participate in a two-phase commit (2PC).
  - PostgreSQL transactions commit first. Once durable state is committed, Redis temporary metadata and indexes are populated.
  - If Redis fails after a PostgreSQL commit, the durable database transaction remains committed and intact. Background recovery and service lookups seamlessly reconcile the state.
  - Redis TTL is not treated as a guaranteed callback. Expiry deadlines are verified authoritatively in PostgreSQL on every confirmation attempt.

---

### Reservation Lifecycle & State Machine

```
              ┌────────────────────────┐
              │ POST /:productId/res   │
              │ (Inventory Reserved)   │
              └───────────┬────────────┘
                          ▼
                    ┌───────────┐
                    │  PENDING  │
                    └───┬───┬───┘
       Confirm Hold     │   │     Cancel Hold
    ┌───────────────────┘   └───────────────────┐
    ▼                                           ▼
┌───────────┐                           ┌───────────┐
│ CONFIRMED │                           │ CANCELLED │
└───────────┘                           └───────────┘
    ▲                                           ▲
    │                                           │
    │        Deadline Passed (now >= expiresAt) │
    └───────────────────┬───────────────────────┘
                        ▼
                  ┌───────────┐
                  │  EXPIRED  │ (Stock Released)
                  └───────────┘
```

1. **`PENDING`**:
   - Stock is reserved in PostgreSQL (`reserved_quantity` incremented; physical `quantity` unchanged).
   - Temporary hold metadata stored in Redis with TTL. Expiry registered in `reservation:expiry` Sorted Set.
2. **`CONFIRMED`**:
   - Permanent stock consumption: PostgreSQL decrements physical `quantity` and releases `reserved_quantity`.
   - Idempotent: repeating confirmation on an already `CONFIRMED` reservation returns the confirmed state without double-decrementing stock.
3. **`CANCELLED`**:
   - Hold cancelled before deadline: PostgreSQL releases `reserved_quantity` back to the available pool.
   - Idempotent: repeating cancellation on an already `CANCELLED` reservation returns the cancelled state without double-releasing stock.
   - Confirmed reservations cannot be cancelled.
4. **`EXPIRED`**:
   - Reservation deadline passed without confirmation.
   - PostgreSQL conditionally marks status `EXPIRED` and decrements `reserved_quantity`, restoring available stock.
   - Expired holds cannot be confirmed or cancelled.

---

### Distributed Locking with Redis

Reservation mutations (confirmation, cancellation, and background expiration) are coordinated by a dedicated distributed lock:

- **Key Pattern**: `lock:reservation:{reservationId}`
- **Acquisition**:
  ```bash
  SET lock:reservation:{reservationId} <uniqueOwnerUuid> PX 5000 NX
  ```
  - `NX`: Mutual exclusion (fails if another process holds the lock).
  - `PX`: Safe TTL in milliseconds (default 5000ms) prevents deadlocks if a worker crashes.
  - Unique owner token (`crypto.randomUUID()`): Identifies the specific caller.
- **Safe Release with Lua Compare-and-Delete**:
  ```lua
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
  ```
  - Guarantees that a process whose lock expired cannot accidentally delete a new lock acquired by another worker.
  - Never issues an unconditional `DEL`.
  - Operates on a single key (`KEYS[1]`), ensuring 100% compatibility with Redis Cluster hash slots.
- **Lock Contention**: Returns HTTP 409 Conflict if the lock is held by a concurrent request.
- **Defense in Depth**: Even if a lock expires during a slow request, PostgreSQL transactions and row-level locks (`SELECT ... FOR UPDATE`) prevent inconsistent database updates.

---

### Expiration & Background Recovery

Because Redis key eviction is asynchronous and not a reliable webhook, Phase 8 employs a dual-source recovery mechanism:

1. **Service-Level Validation**: On every confirmation attempt, the system verifies `now < expiresAt`. If expired, it immediately transitions PostgreSQL status to `EXPIRED`, releases the stock, and rejects confirmation with HTTP 409.
2. **Background Reconciliation Job (`ReservationExpiryJob`)**:
   - Discovers expired candidate IDs from the Redis `reservation:expiry` Sorted Set (`ZRANGEBYSCORE reservation:expiry -inf <nowMs> LIMIT 0 50`).
   - Also queries PostgreSQL for orphaned pending holds (`SELECT id FROM reservations WHERE status = 'PENDING' AND expires_at <= NOW() LIMIT 50`) to recover from Redis eviction or flush events.
   - Executes conditional PostgreSQL updates to release stock and update Redis state.
3. **Multi-Instance Scheduler Coordination**:
   - `ReservationExpiryScheduler` runs periodically (default every 30 seconds).
   - Coordinates multi-instance deployments using distributed lock `lock:job:reservation-expiry`.

---

### Redis Key Patterns Introduced in Phase 8

| Pattern | Redis Data Type | TTL Policy | Purpose |
| :--- | :--- | :--- | :--- |
| `reservation:{reservationId}` | String (JSON) | Hold TTL (default 600s, max 3600s) | Fast-path lookup of temporary hold metadata. |
| `reservation:expiry` | Sorted Set (`ZSET`) | None (managed members) | Score = expiration epoch ms; member = `reservationId`. Enables bounded range queries without `KEYS` or `SCAN`. |
| `reservation:idempotency:{idempotencyKey}` | String | Hold TTL (default 600s) | Fast-path idempotency deduplication mapping to `reservationId`. |
| `lock:reservation:{reservationId}` | String (UUID) | Lock TTL (default 5000ms) | Distributed lock token for coordinating reservation mutations. |
| `lock:job:reservation-expiry` | String (UUID) | Lock TTL (25000ms) | Distributed lock for background expiry scheduler coordination across server instances. |

---

### Reservation API Endpoints

| Method | Endpoint | Access | Concurrency Mechanism | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/inventory/:productId/reservations` | Public | PostgreSQL `SELECT FOR UPDATE` | Creates a temporary stock hold with TTL and idempotency key. |
| `POST` | `/api/inventory/reservations/:reservationId/confirm` | Public | Redis Lock + PostgreSQL `SELECT FOR UPDATE` | Confirms hold, permanently consuming stock. |
| `POST` | `/api/inventory/reservations/:reservationId/cancel` | Public | Redis Lock + PostgreSQL `SELECT FOR UPDATE` | Cancels hold, releasing reserved stock. |
| `GET` | `/api/inventory/reservations/:reservationId` | Public | PostgreSQL Read | Retrieves durable reservation record and expiry status. |

#### Example: Create Reservation Hold

`POST /api/inventory/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/reservations`

```json
{
  "quantity": 2,
  "idempotencyKey": "order-checkout-hold-001",
  "ttlSeconds": 600
}
```

Response (HTTP 201 Created):
```json
{
  "id": "e2a4b8c0-1234-4567-89ab-cdef01234567",
  "productId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "quantity": 2,
  "status": "PENDING",
  "idempotencyKey": "order-checkout-hold-001",
  "expiresAt": "2026-10-15T15:00:00.000Z",
  "confirmedAt": null,
  "cancelledAt": null,
  "createdAt": "2026-10-15T14:50:00.000Z",
  "updatedAt": "2026-10-15T14:50:00.000Z",
  "isExpired": false
}
```

#### Example: Confirm Reservation

`POST /api/inventory/reservations/e2a4b8c0-1234-4567-89ab-cdef01234567/confirm`

Response (HTTP 200 OK):
```json
{
  "id": "e2a4b8c0-1234-4567-89ab-cdef01234567",
  "productId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "quantity": 2,
  "status": "CONFIRMED",
  "idempotencyKey": "order-checkout-hold-001",
  "expiresAt": "2026-10-15T15:00:00.000Z",
  "confirmedAt": "2026-10-15T14:52:10.000Z",
  "cancelledAt": null,
  "createdAt": "2026-10-15T14:50:00.000Z",
  "updatedAt": "2026-10-15T14:52:10.000Z",
  "isExpired": false
}
```

---

## Redis Pub/Sub, Redis Streams, and MongoDB Audit Logs (Phase 9)

### Architecture Overview: Pub/Sub vs. Redis Streams vs. MongoDB

Phase 9 establishes a multi-tiered event publishing and asynchronous auditing architecture:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Application Services                            │
│           (ProductsService, ReservationService, AuthService)           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
                     ┌─────────────────────────────┐
                     │    EventPublisherService    │
                     └──────┬───────────────┬──────┘
                            │               │
        ┌───────────────────┘               └───────────────────┐
        ▼                                                       ▼
┌───────────────────────────┐                       ┌───────────────────────────┐
│       Redis Pub/Sub       │                       │       Redis Streams       │
│  (events:products, etc.)  │                       │  (stream:domain-events)   │
└─────────────┬─────────────┘                       └─────────────┬─────────────┘
              │                                                   │
     Transient Delivery                                  Durable Consumer Group
  (Fire-and-forget broadcast)                           (audit-log-workers / XACK)
              │                                                   │
              ▼                                                   ▼
┌───────────────────────────┐                       ┌───────────────────────────┐
│ CacheInvalidationSubscriber│                       │   AuditLogStreamConsumer  │
│  (Real-time cache eviction)│                       │ (Retries & Dead-Lettering)│
└───────────────────────────┘                       └─────────────┬─────────────┘
                                                                  │
                                                        Idempotent Persistence
                                                                  │
                                                                  ▼
                                                    ┌───────────────────────────┐
                                                    │    MongoDB (audit_logs)   │
                                                    │ (Durable Business History)│
                                                    └───────────────────────────┘
```

| Mechanism | Storage / Engine | Delivery Semantics | Retention / Durability | Intended Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Redis Pub/Sub** | In-memory message bus | At-most-once (fire-and-forget). Disconnected clients miss messages. | 0 retention. Messages disappear immediately after broadcast. | Real-time cache invalidation hints, live UI notifications. |
| **Redis Streams** | In-memory append-only log with RDB/AOF persistence | At-least-once via Consumer Groups (`XREADGROUP`), `XACK`, and `XCLAIM`. | Bounded retention via approximate trimming (`MAXLEN ~ 10000`). | Reliable asynchronous message distribution, audit event queue, decoupled workers. |
| **MongoDB Audit Logs** | MongoDB 8.0 (`audit_logs` collection) | Durable ACID single-document writes. Idempotent deduplication via unique `eventId`. | Permanent / long-term historical retention. | Regulatory audit trail, security history, compliance reporting. |

---

### Event Envelope Contract & Versioning

All events adhere to a versioned TypeScript interface validated via Zod schemas:

```typescript
export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;        // UUIDv4 unique event identifier
  eventType: string;      // Namespaced event name (e.g., 'product.created', 'reservation.confirmed')
  eventVersion: number;   // Schema version (e.g., 1)
  occurredAt: string;     // ISO-8601 timestamp
  correlationId?: string; // Request/workflow tracing identifier
  producer: string;       // Originating module or service name
  payload: T;             // Validated, sanitized event payload
}
```

#### Implemented Event Types:
- **Products**: `product.created`, `product.updated`, `product.deleted`
- **Inventory**: `inventory.adjusted`
- **Reservations**: `reservation.created`, `reservation.confirmed`, `reservation.cancelled`, `reservation.expired`
- **Authentication**: `auth.login.succeeded`, `auth.login.failed`

> **Security & Secret Sanitization**: Event envelopes and audit logs are strictly sanitized recursively. Passwords, password hashes, JWT secrets, refresh tokens, OTP codes, and distributed lock owner tokens are permanently redacted (`[REDACTED]`) before publishing or storage.

---

### Redis Pub/Sub: Channels & Dedicated Subscriber Connection

- **Channel Naming Scheme**:
  - `events:products`
  - `events:inventory`
  - `events:reservations`
  - `events:auth`
- **Dedicated Connection Requirement**: When an ioredis client executes `SUBSCRIBE`, it enters subscriber mode and can no longer issue standard commands (`GET`, `SET`, `XADD`, etc.). The application manages a dedicated subscriber connection (`EventPubSubSubscriber`) while normal publishers reuse the shared client.
- **Cache Invalidation (`CacheInvalidationSubscriber`)**: Listens to `events:products`. When a `product.updated` or `product.deleted` event is broadcast, it immediately purges the corresponding cache entry and cached product lists across all connected instances.

---

### Redis Streams: Consumer Groups, Pending Recovery & Dead-Lettering

- **Stream Keys**:
  - Main Stream: `stream:domain-events` (configurable via `REDIS_STREAM_DOMAIN_EVENTS`)
  - Dead-Letter Stream: `stream:dead-letter:domain-events` (configurable via `REDIS_STREAM_DEAD_LETTER`)
- **Appending Events (`XADD`)**:
  ```bash
  XADD stream:domain-events MAXLEN ~ 10000 * eventId <uuid> eventType <type> ... payload <json>
  ```
  - Approximate trimming (`MAXLEN ~`) limits memory growth without imposing exact trimming overhead on every write.
- **Consumer Group Processing (`XREADGROUP`)**:
  - Group: `audit-log-workers`
  - Consumer: `audit-worker-1`
  - Group created safely with `XGROUP CREATE stream:domain-events audit-log-workers $ MKSTREAM` (catches `BUSYGROUP` gracefully).
  - Reads new messages with blocking timeout (`BLOCK 2000`).
  - Upon successful persistence into MongoDB, acknowledges the message with `XACK stream:domain-events audit-log-workers <entryId>`.
- **Pending Recovery & Dead-Letter Queue**:
  - Every 10 loop iterations, the consumer inspects unacknowledged pending messages using `XPENDING`.
  - Messages idle longer than 60,000ms (`REDIS_STREAM_CLAIM_MIN_IDLE_MS`) are claimed via `XCLAIM`.
  - If a message exceeds max retries (`REDIS_STREAM_MAX_RETRIES = 3`), it is permanently routed to `stream:dead-letter:domain-events` with its sanitized error reason, and then `XACK`ed in the primary stream to unblock the pipeline.

---

### MongoDB Audit Logs: Schema & Idempotent Deduplication

Audit entries are persisted in the `audit_logs` collection via Mongoose:

```typescript
{
  eventId: String,        // Unique UUIDv4 (unique index)
  eventType: String,      // Indexed
  eventVersion: Number,
  occurredAt: Date,       // Indexed
  recordedAt: Date,       // Default Date.now
  actorId: String,        // Optional user UUID (indexed)
  targetType: String,     // Target resource type (indexed)
  targetId: String,       // Target resource ID (indexed)
  correlationId: String,  // Optional trace ID (indexed)
  source: String,         // Producer name
  outcome: String,        // 'SUCCESS' | 'FAILURE'
  metadata: Mixed         // Sanitized payload
}
```

- **Idempotency Strategy**: The collection enforces a unique index on `eventId`. If a message is re-delivered (due to worker crash, network retry, or claim replay), MongoDB throws duplicate key error `E11000`. The service catches `11000`, logs the idempotent replay, and returns the existing document without error.
- **Query Endpoints (ADMIN only)**:
  - `GET /api/audit-logs`: Paginated audit log search with filters (`eventType`, `targetType`, `targetId`, `actorId`, `correlationId`, `startDate`, `endDate`).
  - `GET /api/audit-logs/:eventId`: Direct retrieval by event ID.

---

### Transactional Outbox Pattern (PostgreSQL)

To prevent cross-store dual-write inconsistency between PostgreSQL transactions and Redis:

1. **Atomic Outbox Insert**: Within the same PostgreSQL transaction that modifies inventory or reservations, an event row is inserted into `outbox_events` with `status = 'PENDING'`.
2. **Post-Commit Fast Path**: The service attempts immediate non-blocking Redis publishing upon transaction commit.
3. **Background Outbox Dispatcher (`OutboxScheduler`)**: Periodically scans `outbox_events` for `PENDING` records, dispatches them to Redis Pub/Sub and Redis Streams, and marks them `PUBLISHED`. If Redis is temporarily down, events remain persisted in PostgreSQL and will be dispatched once Redis recovers.

---

### Redis Key Inventory (All Phases Implemented)

| Key Pattern | Redis Type | Phase | TTL Policy | Description |
| :--- | :--- | :--- | :--- | :--- |
| `refresh:{userId}:{jti}` | String (Token) | Phase 3 | 7 days (`JWT_REFRESH_EXPIRATION_SECONDS`) | Refresh token hash session. |
| `user_sessions:{userId}` | List | Phase 3 | None (managed FIFO, max 2 items) | Active refresh session tracker. |
| `blacklist:{jti}` | String (`'revoked'`) | Phase 4 | Remaining token TTL (max 900s) | Revoked access token blacklist. |
| `otp:{purpose}:{email}` | Hash | Phase 4 | 300s (`OTP_EXPIRATION_SECONDS`) | One-time password verification data. |
| `otp:cooldown:{purpose}:{email}` | String (`'active'`) | Phase 4 | 60s (`OTP_COOLDOWN_SECONDS`) | Cooldown rate limiter for OTP requests. |
| `ratelimit:{tier}:{ip}` | Sorted Set (`ZSET`) | Phase 4 | Sliding window duration (60s - 300s) | Sliding-window request timestamps. |
| `product:{id}` | String (JSON) | Phase 5 | 300s (`PRODUCT_CACHE_TTL_SECONDS`) | Individual product cache. |
| `products:list:{fingerprint}` | String (JSON) | Phase 5 | 60s (`PRODUCT_LIST_CACHE_TTL_SECONDS`) | Paginated product list cache. |
| `lock:product:cache:{id}` | String (UUID) | Phase 5 | 2000ms (`PRODUCT_CACHE_LOCK_TTL_MS`) | Mutex for cache stampede protection. |
| `views:product:{productId}` | String (Counter) | Phase 6 | None (drained periodically) | High-throughput product view counter. |
| `views:active_products` | Set | Phase 6 | None (managed members) | Tracking set of products with un-aggregated views. |
| `views:pending_batches` | Set | Phase 6 | None (managed members) | Set of pending aggregation batch IDs. |
| `views:batch:{batchId}` | Hash | Phase 6 | 86400s (24 hours) | Drained view counts awaiting MySQL sync. |
| `leaderboard:trending` | Sorted Set (`ZSET`) | Phase 6 | None (managed ranks) | Real-time popularity ranking via `ZINCRBY`. |
| `views:unique:product:{id}` | HyperLogLog | Phase 6 | 86400s (24 hours) | Cardinality estimator for unique viewers via `PFADD`. |
| `lock:job:product-view-aggregation`| String (UUID) | Phase 6 | 30000ms | Multi-instance lock for view aggregation scheduler. |
| `stock:{productId}` | String (Counter) | Phase 7 | None (active reservation counter) | Redis Lua atomic reservation counter. |
| `reservation:{reservationId}` | String (JSON) | Phase 8 | Hold TTL (default 600s, max 3600s) | Fast-path temporary reservation hold metadata. |
| `reservation:expiry` | Sorted Set (`ZSET`) | Phase 8 | None (managed members) | Score = timestamp ms; member = reservationId for bounded cleanup. |
| `reservation:idempotency:{idempKey}` | String | Phase 8 | Hold TTL (default 600s) | Idempotent reservation deduplication mapping. |
| `lock:reservation:{reservationId}` | String (UUID) | Phase 8 | 5000ms (`RESERVATION_LOCK_TTL_MS`) | Distributed lock for reservation state mutations. |
| `lock:job:reservation-expiry` | String (UUID) | Phase 8 | 25000ms | Multi-instance lock for reservation expiry scheduler. |
| `stream:domain-events` | Stream | Phase 9 | Approximate trimming (`MAXLEN ~ 10000`) | Durable event log for consumer groups. |
| `stream:dead-letter:domain-events`| Stream | Phase 9 | None (permanent audit retention) | Poison and repeatedly failing messages. |

> **Note on Verification**: In accordance with project instructions, Phase 9 source code, schema migrations, and tests have been authored but **not yet executed or runtime-verified**. Full verification will occur after all 10 phases are completed.

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

