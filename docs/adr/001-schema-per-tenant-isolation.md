# ADR-001: Schema-Per-Tenant Isolation

## Status

Accepted

## Date

2025-08-22

## Context

Multi-tenant SaaS applications must isolate tenant data to prevent leakage between tenants. There are three common strategies for data isolation in a relational database:

1. **Shared tables with a `tenant_id` column** -- All tenants share the same tables. Every query must include a `WHERE tenant_id = ?` filter. This is the simplest approach operationally but carries the highest risk: a missing filter silently exposes data across tenants. It also makes it difficult to offer per-tenant backup/restore, and noisy-neighbor problems surface at the query level since all tenants share indexes.

2. **Schema per tenant** -- Each tenant gets its own Postgres schema within a shared database. Tables are identical in structure but scoped by `SET search_path`. Cross-tenant access requires an explicit schema qualification, which is easy to prevent. Migrations must run once per schema.

3. **Database per tenant** -- Each tenant gets a dedicated database. This provides the strongest isolation and the simplest mental model, but it is operationally expensive: connection pooling is per-database, migrations multiply by tenant count at the infrastructure level, and provisioning a new tenant means creating a new database (which may require different credentials, monitoring, backups).

We need to choose a default strategy that balances isolation strength, operational cost, and developer experience.

## Decision

We adopt **schema-per-tenant** as the default isolation model.

- Each tenant is assigned a Postgres schema named `tenant_{tenant_id}`.
- The framework sets `search_path` to the tenant's schema on every connection before executing queries.
- Cross-tenant data (the tenant registry itself, global configuration, the outbox relay cursor) lives in the `public` schema.
- The `TenantPool` abstraction transparently handles schema switching so application code never manually sets `search_path`.

## Trade-offs

### Advantages

- **Strong isolation without infrastructure overhead.** A missing `WHERE` clause cannot leak data because the schema boundary enforces it at the database level.
- **Per-tenant operations are straightforward.** Backup a schema with `pg_dump -n tenant_xyz`. Drop a tenant by dropping a schema. Restore a single tenant without affecting others.
- **Shared connection pool.** Unlike database-per-tenant, all schemas live in the same database, so a single `pg` pool can serve all tenants by switching `search_path`.
- **Familiar Postgres tooling.** No special extensions or row-level security policies required (though RLS can be layered on for defense in depth).

### Disadvantages

- **Migration complexity.** Every DDL migration must execute once per tenant schema. For 1,000 tenants, a single `ALTER TABLE` becomes 1,000 statements. The `TenantMigrator` handles this, but it adds deployment time.
- **Schema count limits.** Postgres handles thousands of schemas well, but at tens of thousands the catalog can slow down. If the application is expected to exceed ~10,000 tenants, consider row-level security as an alternative or complement.
- **Connection pool pressure.** Each `SET search_path` call is a round-trip. We mitigate this by issuing it as part of the connection checkout, not as a separate statement.

## Consequences

1. The `TenantPool` must intercept every connection checkout and execute `SET search_path TO tenant_{id}, public` before returning the connection to the caller.
2. The `TenantMigrator` must enumerate all tenant schemas and run pending migrations against each one. It must handle partial failures (some schemas migrated, some not) gracefully and support retries.
3. Provisioning a new tenant means creating a new schema and running all migrations from scratch.
4. The `TenantQuery` builder must refuse to execute queries when no tenant context is present, preventing accidental queries against the `public` schema.
5. Admin operations (listing tenants, cross-tenant analytics) must explicitly opt in to querying the `public` schema or iterating schemas.
