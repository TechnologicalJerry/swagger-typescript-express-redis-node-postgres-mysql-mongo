# Redis Learning Backend

A learning-focused backend designed to demonstrate practical Redis concepts through production-grade APIs, automated tests, and direct database inspection using `redis-cli` and RedisInsight.

## Architecture & Data Store Ownership

The application connects to four distinct data stores, each with strict domain ownership:

- **PostgreSQL 18** (via Prisma ORM 7 & `@prisma/adapter-pg`):
  - Planned domain: Users, roles, and inventory.
- **MySQL 8.4** (via Prisma ORM 7 & `@prisma/adapter-mariadb`):
  - Planned domain: Product catalog.
- **MongoDB 8.0** (via Mongoose 9):
  - Planned domain: Audit logs and login history.
- **Redis 8.6** (via ioredis 5/6):
  - Planned domain: Cache, authentication sessions, counters, distributed locks, messaging, and background job queues.
- **Mailpit** (via `axllent/mailpit:v1.31`):
  - Local SMTP testing interface for subsequent phases.

> **Note:** Phase 1 focuses exclusively on establishing the foundational infrastructure, Docker orchestration, environment configuration, database connection lifecycles, health/readiness probes, and testing harness. Business features will be introduced in subsequent phases.

---

## Technology Stack & Verified Versions

| Component           | Target / Requested              | Verified Stable Release           | Notes                                                   |
| :------------------ | :------------------------------ | :-------------------------------- | :------------------------------------------------------ |
| **Runtime**         | Node.js 24 LTS                  | `v24.19.0` (LTS)                  | Native ESM enabled (`type: "module"`)                   |
| **Package Manager** | npm                             | `12.0.2`                          | Clean lockfile management                               |
| **Language**        | TypeScript 6 (or latest stable) | `6.0.3`                           | Strict configuration with `NodeNext` resolution         |
| **HTTP Framework**  | Express 5                       | `5.0.0` (`@types/express: 5.0.6`) | Modern Express with native async error routing          |
| **Configuration**   | Zod 4                           | `4.6.7`                           | Fail-fast validation with sanitized secret reporting    |
| **PostgreSQL**      | PostgreSQL 18                   | `postgres:18` (Docker)            | Volume mapped to `/var/lib/postgresql`                  |
| **MySQL**           | MySQL 8.4 LTS                   | `mysql:8.4` (Docker)              | Native `mysqladmin ping` health probe                   |
| **MongoDB**         | MongoDB 8.0                     | `mongo:8.0` (Docker)              | `mongosh --eval "db.adminCommand('ping')"` health probe |
| **Redis**           | Redis 8.6                       | `redis:8.6` (Docker)              | Runs `redis-server --requirepass` with health check     |
| **Email Testing**   | Mailpit                         | `axllent/mailpit:v1.31`           | Web UI on `8025`, SMTP on `1025`                        |
| **ORM (SQL)**       | Prisma ORM 7                    | `7.10.0`                          | Dual independent configurations & client generations    |
| **MongoDB ODM**     | Mongoose                        | `9.1.2`                           | Fully compatible with Node 24 and Mongo 8               |
| **Redis Client**    | ioredis                         | `5.6.0`                           | Reusable client with bounded timeouts and redacted logs |
| **Logging**         | Pino & pino-http                | `9.6.0` / `10.4.0`                | Structured JSON logs with automated secret masking      |
| **Security**        | Helmet & CORS                   | `8.0.0` / `2.8.5`                 | Production HTTP headers and origin constraints          |
| **Testing**         | Vitest & Supertest              | `3.2.7` / `7.0.0`                 | Fast in-memory unit & live integration tests            |
| **Code Quality**    | ESLint 9 & Prettier             | `9.21.0` / `3.5.0`                | Modern Flat Config (`eslint.config.js`)                 |

---

## Prerequisites

1. **Node.js**: `v24.19.0` or later (Node 24 LTS).
2. **Docker & Docker Compose**: Docker 29+ and Docker Compose v5+ (or Docker Desktop).
3. Ports available on localhost:
   - `5432` or `5433` (PostgreSQL)
   - `3306` (MySQL)
   - `27017` or `27018` (MongoDB)
   - `6379` (Redis)
   - `1025` & `8025` (Mailpit SMTP and Web UI)

---

## Environment Setup

1. Copy the example environment template:

   ```bash
   cp .env.example .env
   ```

2. Review `.env` configuration. If running on a host machine with existing PostgreSQL or MongoDB services installed locally on ports `5432` or `27017`, use the non-conflicting port overrides:
   - `POSTGRES_PORT=5433`
   - `POSTGRES_URL=postgresql://postgres:postgres@localhost:5433/redis_learning_pg?schema=public`
   - `MONGO_PORT=27018`
   - `MONGO_URL=mongodb://root:mongopassword@localhost:27018/redis_learning_mongo?authSource=admin`

---

## Docker Compose Commands

### Start All Services in Background

```bash
docker compose up -d
```

### Inspect Service Status and Health

```bash
docker compose ps
```

All 5 services should show `Up (...) (healthy)`.

### View Logs

```bash
# View all container logs
docker compose logs -f

# View specific service logs
docker compose logs -f redis
docker compose logs -f postgres
```

### Stop All Services

```bash
# Stop containers without losing data
docker compose stop

# Stop containers and tear down networks
docker compose down

# Stop containers and reset persistent volumes (use with caution)
docker compose down -v
```

---

## Prisma Setup & Client Generation

The repository uses separate Prisma configuration files and schemas for PostgreSQL and MySQL:

- `prisma/postgres/prisma.config.ts` -> `prisma/postgres/schema.prisma` -> `src/db/postgres/generated/`
- `prisma/mysql/prisma.config.ts` -> `prisma/mysql/schema.prisma` -> `src/db/mysql/generated/`

Generate both clients simultaneously:

```bash
npm run prisma:generate
```

Or individually:

```bash
npm run prisma:generate:postgres
npm run prisma:generate:mysql
```

---

## Starting and Stopping the Application

### Development Mode (with hot-reload via tsx)

```bash
npm run dev
```

### Production Build & Execution

```bash
# 1. Compile TypeScript into dist/
npm run build

# 2. Run compiled production bundle
npm start
```

### Graceful Shutdown

To stop the running application, send `SIGINT` (`Ctrl+C`) or `SIGTERM`. The server will:

1. Stop accepting new HTTP requests.
2. Allow ongoing requests to finish.
3. Cleanly close connections to PostgreSQL, MySQL, MongoDB, and Redis.
4. Enforce a bounded timeout (`SHUTDOWN_TIMEOUT_MS`, default 10 seconds).

---

## Health and Readiness Endpoints

### 1. Application Liveness: `GET /health`

- **Purpose**: Confirms the HTTP runtime is alive and processing requests.
- **Behavior**: Returns HTTP 200 as long as Express is operational, regardless of database status.

```bash
curl -i http://localhost:3000/health
```

Example response:

```json
{
  "status": "ok",
  "uptime": 45.12,
  "timestamp": "2026-10-13T18:27:00.045Z"
}
```

### 2. Dependency Readiness: `GET /ready`

- **Purpose**: Verifies that backing data stores (PostgreSQL, MySQL, MongoDB, Redis) are reachable and responding to lightweight read-only connectivity checks.
- **Behavior**: Returns HTTP 200 when all four stores are ready; returns HTTP 503 if any store fails. Bounded by a 3000ms timeout per check.

```bash
curl -i http://localhost:3000/ready
```

Example response (All Healthy - HTTP 200):

```json
{
  "status": "ready",
  "dependencies": {
    "postgres": { "status": "up" },
    "mysql": { "status": "up" },
    "mongo": { "status": "up" },
    "redis": { "status": "up" }
  },
  "timestamp": "2026-10-13T18:27:00.246Z"
}
```

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

## Redis Inspection & Troubleshooting

Inspect the running Redis 8.6 container directly using `redis-cli`:

### Check Redis Liveness (`PING`)

```bash
docker compose exec redis redis-cli -a redispassword PING
```

_Expected output:_ `PONG`

### Verify Key Count in Database (`DBSIZE`)

```bash
docker compose exec redis redis-cli -a redispassword DBSIZE
```

_Expected output:_ `0` (for a fresh database)

### Inspect Redis Server Information

```bash
docker compose exec redis redis-cli -a redispassword INFO server
```

### Inspect Redis Memory Usage

```bash
docker compose exec redis redis-cli -a redispassword INFO memory
```
