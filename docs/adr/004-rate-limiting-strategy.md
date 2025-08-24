# ADR-004: Rate Limiting Strategy

## Status

Accepted

## Date

2025-08-24

## Context

In a multi-tenant system, a single tenant can monopolize shared resources (database connections, CPU, network bandwidth), degrading the experience for all other tenants. This is the "noisy neighbor" problem.

Rate limiting is the primary defense. We need to choose algorithms that balance fairness, burst tolerance, and implementation complexity. The main candidates:

1. **Fixed window** -- Count requests in fixed time windows (e.g., 100 requests per minute). Simple, but suffers from boundary spikes: a tenant can make 100 requests at 0:59 and 100 more at 1:00, effectively getting 200 requests in 2 seconds.

2. **Sliding window** -- Approximation of a true sliding window using the current and previous window counts, weighted by elapsed time. Smooths out boundary spikes. Good for quota enforcement ("1,000 API calls per hour").

3. **Token bucket** -- A bucket holds tokens up to a maximum capacity. Tokens are added at a fixed rate. Each request consumes one or more tokens. If the bucket is empty, the request is rejected. Allows controlled bursts (up to bucket capacity) while enforcing a sustained rate. Good for API rate limiting.

4. **Leaky bucket** -- Similar to token bucket but enforces a strict output rate. Requests are queued and processed at a fixed rate. More predictable but adds latency (queuing). Not suitable for a framework middleware since it would need to buffer requests.

## Decision

We ship two built-in strategies:

1. **Token bucket** -- Default for API rate limiting. Allows bursts up to the bucket capacity while maintaining a sustainable average rate. Configuration: `capacity` (max burst), `refillRate` (tokens per second).

2. **Sliding window** -- For quota tracking (e.g., "10,000 API calls per day" or "100 file uploads per hour"). Configuration: `windowMs` (window duration), `maxRequests` (requests per window).

Both implement a shared `RateLimiter` interface:

```typescript
interface RateLimiter {
  consume(key: string, tokens?: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}
```

The rate limit middleware automatically scopes the key by tenant ID (from `TenantContext`), so per-tenant limits are enforced without manual key construction.

Default storage is in-memory (a `Map`). For distributed deployments, the `RateLimiter` interface can be implemented with a Redis backend. We do not ship a Redis implementation to avoid the dependency, but the interface is designed to be Redis-friendly (single `consume` operation, no multi-step check-and-decrement).

## Trade-offs

### Token Bucket

- **Pro**: Allows bursts, which matches real API usage patterns (UI rendering triggers multiple parallel requests).
- **Pro**: Simple mental model -- "you get N tokens per second, can save up to M".
- **Con**: Burst allowance means a tenant can briefly exceed the sustained rate. If downstream systems cannot handle bursts, this is a problem.

### Sliding Window

- **Pro**: More predictable rate enforcement. No burst spikes.
- **Pro**: Natural fit for business quotas ("your plan includes 10,000 API calls per month").
- **Con**: Approximation introduces a small error at window boundaries (up to 1 request in edge cases).

### In-Memory Default

- **Pro**: Zero external dependencies. Works out of the box.
- **Con**: State is per-process. In a multi-instance deployment, each instance tracks its own counts, effectively multiplying the limit by the number of instances. For production multi-instance deployments, a Redis-backed implementation is necessary.

## Consequences

1. The `RateLimitMiddleware` reads the tenant from `TenantContext` and calls `consume(tenantId)` on the configured limiter.
2. When rate limited, the middleware returns HTTP 429 with a `Retry-After` header computed from `retryAfterMs`.
3. Tenant tier-based limits are supported: the middleware can look up the tenant's tier from the registry and apply different limits per tier.
4. The in-memory implementations clean up stale entries to prevent memory leaks (buckets that have not been accessed for longer than their refill period are pruned).
