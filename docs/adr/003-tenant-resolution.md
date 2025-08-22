# ADR-003: Tenant Resolution Strategy

## Status

Accepted

## Date

2025-08-22

## Context

Every inbound request must be attributed to a tenant before any business logic executes. The tenant identity determines which database schema to query, which rate limits to apply, and which auth provider to validate against.

There is no single standard for how tenants are identified in HTTP requests. Common approaches:

1. **Subdomain**: `acme.app.com` -- The subdomain `acme` identifies the tenant. Popular with B2B SaaS (Slack, Notion, etc.). Requires wildcard DNS and TLS.
2. **Path prefix**: `/tenants/acme/api/orders` -- The first path segment identifies the tenant. Simple to implement, no DNS requirements, but pollutes the URL namespace.
3. **HTTP header**: `X-Tenant-ID: acme` -- Common for API-first platforms and service-to-service calls. Not suitable for browser-based access without a proxy.
4. **JWT claim**: The tenant ID is embedded in the access token as a claim (e.g., `tenant_id`). Requires authentication before tenant resolution, which inverts the typical middleware order.

Different deployment models favor different strategies. A single-domain API gateway might use headers. A white-label product might use subdomains. An internal microservice mesh might use JWT claims.

## Decision

We define a **pluggable `TenantResolver` interface** with built-in implementations for all four strategies:

```typescript
interface TenantResolver {
  resolve(req: IncomingMessage): Promise<string | null>;
}
```

Built-in resolvers:
- `HeaderTenantResolver` -- reads from a configurable header (default `x-tenant-id`)
- `SubdomainTenantResolver` -- extracts the first subdomain from the `Host` header
- `PathTenantResolver` -- extracts the tenant from a configurable path segment (default: first segment)
- `JwtTenantResolver` -- decodes (but does not verify) the JWT to extract a tenant claim

Resolvers can be composed with a `ChainTenantResolver` that tries each resolver in order and returns the first non-null result.

Once a tenant ID is resolved, it is validated against the `TenantRegistry` and then stored in `AsyncLocalStorage` via `TenantContext`. All downstream code (DB queries, event publishing, rate limiting, logging) reads the tenant from the context without requiring explicit parameters.

## Trade-offs

### Advantages

- **Framework-agnostic.** Resolvers receive a standard `IncomingMessage`, so they work with Express, Fastify, Koa, raw Node `http`, or any framework that exposes the underlying request.
- **Composable.** The chain resolver allows fallback strategies (try header first, then subdomain). This is useful during migrations from one strategy to another.
- **AsyncLocalStorage propagation.** Once the tenant is resolved and stored, every layer of the application has access to it without function parameter drilling. This is especially valuable in deeply nested code and third-party library integrations.

### Disadvantages

- **AsyncLocalStorage performance.** There is a small overhead (~2-5% in microbenchmarks) from AsyncLocalStorage. In practice, this is negligible compared to I/O, but it is worth noting.
- **Implicit context.** AsyncLocalStorage is a form of thread-local state. It can be surprising to developers unfamiliar with it. We mitigate this by throwing a clear error (`TenantNotFoundError`) when code attempts to read the tenant context outside of a resolved request.
- **JWT resolver does not verify.** The `JwtTenantResolver` decodes without verification because full JWT validation happens later in the auth middleware. If used standalone, the caller must be aware that the tenant ID is unverified.

## Consequences

1. The HTTP middleware pipeline is: resolve tenant -> validate tenant exists -> store in AsyncLocalStorage -> auth -> rate limit -> handler.
2. Application code calls `TenantContext.current()` to get the current tenant. No need to pass tenant through function signatures.
3. The resolver is configured at application startup as part of `MultiverseConfig`. Developers choose which strategy (or chain) to use.
4. Custom resolvers (e.g., reading from a database-backed domain mapping) are supported by implementing the `TenantResolver` interface.
