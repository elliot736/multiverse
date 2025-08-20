// === Tenant ===
export { TenantContext } from './tenant/context.js';
export type { Tenant, TenantConfig } from './tenant/context.js';
export type { TenantResolver } from './tenant/resolver.js';
export {
  HeaderTenantResolver,
  SubdomainTenantResolver,
  PathTenantResolver,
  JwtTenantResolver,
  ChainTenantResolver,
} from './tenant/resolver.js';
export type { TenantRegistry, CreateTenantInput } from './tenant/registry.js';
export { MemoryTenantRegistry, PostgresTenantRegistry } from './tenant/registry.js';

// === Database ===
export { TenantPool } from './db/pool.js';
export { TenantQuery } from './db/query.js';
export type { TransactionScope } from './db/query.js';
export { TenantMigrator } from './db/migrations.js';
export type { MigrateAllResult } from './db/migrations.js';

// === Auth ===
export { authMiddleware, getUser, requireUser } from './auth/middleware.js';
export type { AuthenticatedRequest } from './auth/middleware.js';
export { verifyToken, decodeToken, clearJwksCache } from './auth/oidc.js';
export type { AuthConfig, TenantUser, TenantOidcConfig } from './auth/types.js';

// === Events ===
export { Outbox } from './events/outbox.js';
export { OutboxRelay } from './events/relay.js';
export type { RelayOptions, PollResult } from './events/relay.js';
export type { EventBus } from './events/bus.js';
export { InMemoryEventBus } from './events/bus.js';
export type { OutboxEvent, DomainEvent, EventHandler, OutboxRow } from './events/types.js';

// === Rate Limiting ===
export type { RateLimiter, RateLimitResult, TokenBucketConfig, SlidingWindowConfig } from './ratelimit/strategies.js';
export { TokenBucketLimiter, SlidingWindowLimiter } from './ratelimit/strategies.js';
export { TenantRateLimiter } from './ratelimit/limiter.js';
export type { TenantRateLimiterConfig } from './ratelimit/limiter.js';
export { rateLimitMiddleware } from './ratelimit/middleware.js';
export type { RateLimitMiddlewareConfig } from './ratelimit/middleware.js';

// === HTTP ===
export { createMultiverseMiddleware, composeMiddleware } from './http/middleware.js';
export type { MultiverseConfig } from './http/middleware.js';
export type { Middleware, TenantRequest } from './http/types.js';

// === Errors ===
export {
  MultiverseError,
  TenantNotFoundError,
  CrossTenantAccessError,
  NoTenantContextError,
  RateLimitExceededError,
  OutboxPublishError,
  AuthenticationError,
  TenantResolutionError,
  MigrationError,
} from './errors.js';
