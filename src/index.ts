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
