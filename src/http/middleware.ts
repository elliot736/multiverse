import type { IncomingMessage, ServerResponse } from 'node:http';
import { TenantContext } from '../tenant/context.js';
import type { TenantResolver } from '../tenant/resolver.js';
import type { TenantRegistry } from '../tenant/registry.js';
// Errors used in middleware responses
import type { AuthConfig } from '../auth/types.js';
import { authMiddleware } from '../auth/middleware.js';
import type { TenantRateLimiter } from '../ratelimit/limiter.js';
import { rateLimitMiddleware } from '../ratelimit/middleware.js';
import type { Middleware, TenantRequest } from './types.js';

/**
 * Configuration for the composed Multiverse middleware.
 */
export interface MultiverseConfig {
  /** Strategy for resolving tenant from request */
  resolver: TenantResolver;
  /** Registry for looking up tenant metadata */
  registry: TenantRegistry;
  /** Auth configuration. Omit to skip authentication. */
  auth?: AuthConfig;
  /** Rate limiter. Omit to skip rate limiting. */
  rateLimiter?: TenantRateLimiter;
  /**
   * Paths that bypass tenant resolution entirely (e.g., health checks).
   * Supports exact matches and prefix matches (ending with *).
   */
  publicPaths?: string[];
}

/**
 * Create the composed Multiverse middleware stack:
 * 1. Public path check (skip if public)
 * 2. Tenant resolution (extract tenant ID from request)
 * 3. Tenant validation (look up in registry, ensure active)
 * 4. Tenant context propagation (store in AsyncLocalStorage)
 * 5. Authentication (JWT validation + tenant cross-reference)
 * 6. Rate limiting (per-tenant)
 *
 * All subsequent middleware/handlers run within the tenant context.
 */
export function createMultiverseMiddleware(config: MultiverseConfig): Middleware {
  const { resolver, registry, publicPaths = [] } = config;

  // Pre-build auth middleware if configured
  const authMw = config.auth
    ? authMiddleware(config.auth, registry)
    : null;

  // Pre-build rate limit middleware if configured
  const rateLimitMw = config.rateLimiter
    ? rateLimitMiddleware({ limiter: config.rateLimiter })
    : null;

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>,
  ): Promise<void> => {
    // 1. Check public paths
    const path = req.url?.split('?')[0] ?? '';
    if (isPublicPath(path, publicPaths)) {
      return next();
    }

    // 2. Resolve tenant ID
    const tenantId = await resolver.resolve(req);
    if (!tenantId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unable to determine tenant from request' }));
      return;
    }

    // 3. Validate tenant exists and is active
    const tenant = await registry.get(tenantId);
    if (!tenant) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Tenant not found: ${tenantId}` }));
      return;
    }
