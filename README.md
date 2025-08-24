# multiverse

> An opinionated TypeScript framework for building multi-tenant SaaS applications, tenant isolation, scoped auth, transactional outbox, and rate limiting out of the box.

[![CI](https://github.com/elliot736/multiverse/actions/workflows/ci.yml/badge.svg)](https://github.com/elliot736/multiverse/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why multiverse?

Building multi-tenant SaaS is hard. Tenant isolation, cross-tenant data leaks, noisy neighbors, auth scoping -- most teams hand-roll these primitives and get them wrong. A missing `WHERE tenant_id = ?` clause silently exposes data. A forgotten rate limit lets one tenant starve the rest. An event published outside a transaction disappears on crash.

multiverse provides production-tested building blocks so you can focus on your product. Schema-per-tenant isolation enforced at the database level, scoped JWT validation, transactional event publishing, and per-tenant rate limiting -- all wired together into a composable middleware stack that works with any Node.js HTTP framework.

## Features

- **Schema-per-tenant isolation** -- each tenant gets a dedicated Postgres schema; cross-tenant queries are rejected at the framework level
- **Pluggable tenant resolution** -- header, subdomain, path, JWT, or custom resolvers with chain fallback
- **Scoped authentication** -- JWT validation with tenant claim enforcement, per-tenant OIDC provider support
- **Transactional outbox** -- reliable event publishing with exactly-once semantics via the outbox pattern
- **Per-tenant rate limiting** -- token bucket + sliding window with tier-based overrides
- **Implicit tenant propagation** -- AsyncLocalStorage-based context, no manual parameter passing
- **Cross-tenant access prevention** -- query builder rejects cross-schema access unless explicitly allowed

## Architecture

```
                     HTTP Request
                          |
                          v
             +------------------------+
             |   Tenant Resolution    |  <-- Header / Subdomain / Path / JWT
             +------------------------+
                          |
                          v
             +------------------------+
             |   Tenant Validation    |  <-- Registry lookup, status check
             +------------------------+
                          |
                          v
             +------------------------+
             | AsyncLocalStorage CTX  |  <-- TenantContext.run(tenant, ...)
             +------------------------+
                          |
                     +----+----+
                     |         |
                     v         v
             +----------+ +----------+
             |   Auth   | |  Rate    |
             | (OIDC)   | | Limiter  |
             +----------+ +----------+
                     |         |
                     +----+----+
                          |
                          v
             +------------------------+
             |     Request Handler    |
             +------------------------+
                     |         |
                     v         v
             +----------+ +----------+
             | Tenant   | | Outbox   |  <-- Same DB transaction
             | Query    | | (events) |
             +----------+ +----------+
                               |
                               v
                     +------------------+
                     |  Outbox Relay    |  <-- Polls & publishes
                     +------------------+
                               |
                               v
                     +------------------+
                     |   Event Bus      |  <-- In-memory / Kafka / SQS
                     +------------------+
```

## Quick Start

```typescript
import {
  createMultiverseMiddleware,
  MemoryTenantRegistry,
  HeaderTenantResolver,
  TenantPool,
  TenantQuery,
  Outbox,
  TenantRateLimiter,
  TenantContext,
} from "multiverse";
import { createServer } from "node:http";

const registry = new MemoryTenantRegistry();
const pool = new TenantPool({ connectionString: process.env.DATABASE_URL });
const query = new TenantQuery(pool);

const middleware = createMultiverseMiddleware({
  resolver: new HeaderTenantResolver("x-tenant-id"),
  registry,
  auth: { skipAuth: true },
  rateLimiter: new TenantRateLimiter({
    strategy: { type: "token-bucket", capacity: 100, refillRate: 10 },
  }),
  publicPaths: ["/health"],
});

const server = createServer(async (req, res) => {
  await middleware(req, res, async () => {
    const tenant = TenantContext.current();
    const rows = await query.query("SELECT * FROM orders LIMIT 10");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tenant: tenant.id, orders: rows }));
  });
});

server.listen(3000);
```

## Usage

### Tenant Resolution

```typescript
import {
  HeaderTenantResolver,
  SubdomainTenantResolver,
  PathTenantResolver,
  JwtTenantResolver,
  ChainTenantResolver,
} from "multiverse";

// From HTTP header (default: x-tenant-id)
const headerResolver = new HeaderTenantResolver("x-tenant-id");

// From subdomain: acme.app.example.com -> "acme"
const subdomainResolver = new SubdomainTenantResolver("app.example.com");

// From URL path: /t/acme/api/orders -> "acme"
const pathResolver = new PathTenantResolver("/t/");

// From JWT claim (decoded, not verified -- verification happens in auth middleware)
const jwtResolver = new JwtTenantResolver("tenant_id");

// Chain: try header first, fall back to subdomain
const chainResolver = new ChainTenantResolver([
  headerResolver,
  subdomainResolver,
]);
```

### Database -- Schema-Per-Tenant

```typescript
import {
  TenantPool,
  TenantQuery,
  TenantMigrator,
  TenantContext,
} from "multiverse";

const pool = new TenantPool({ connectionString: process.env.DATABASE_URL });
const query = new TenantQuery(pool);
const migrator = new TenantMigrator(pool, "./migrations");

// Provision a new tenant (creates schema + runs migrations)
await migrator.provision("acme");

// Query within a tenant context
await TenantContext.run(tenant, async () => {
  const users = await query.query("SELECT * FROM users WHERE active = $1", [
    true,
  ]);

  // Transaction with automatic BEGIN/COMMIT/ROLLBACK
  await query.transaction(async (tx) => {
    await tx.query("INSERT INTO orders (id, total) VALUES ($1, $2)", [
      "ord-1",
      99.99,
    ]);
    await tx.query("INSERT INTO order_items (order_id, sku) VALUES ($1, $2)", [
      "ord-1",
      "WIDGET",
    ]);
  });
});

// Migrate all existing tenants
const result = await migrator.migrateAll();
console.log(
  `Migrated: ${result.succeeded.length}, Failed: ${result.failed.length}`,
);
```

### Transactional Outbox

```typescript
import { Outbox, OutboxRelay, InMemoryEventBus, TenantPool } from "multiverse";

const bus = new InMemoryEventBus();
const outbox = new Outbox();
const relay = new OutboxRelay(pool, bus, { pollIntervalMs: 1000 });
