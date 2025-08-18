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

    if (tenant.status === 'suspended') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Tenant suspended: ${tenantId}` }));
      return;
    }

    // Set tenant ID on request for easy access
    (req as TenantRequest).tenantId = tenantId;

    // 4. Run everything else within tenant context
    return TenantContext.run(tenant, async () => {
      // 5. Auth
      if (authMw) {
        let authCalled = false;
        await authMw(req, res, async () => {
          authCalled = true;
        });
        if (!authCalled) return; // Auth middleware handled the response (e.g., 401)
      }

      // 6. Rate limit
      if (rateLimitMw) {
        let rateLimitCalled = false;
        await rateLimitMw(req, res, async () => {
          rateLimitCalled = true;
        });
        if (!rateLimitCalled) return; // Rate limit middleware handled the response (e.g., 429)
      }

      // 7. Call the actual handler
      return next();
    });
  };
}

/**
 * Check if a path matches any of the public paths.
 */
function isPublicPath(path: string, publicPaths: string[]): boolean {
  for (const publicPath of publicPaths) {
    if (publicPath.endsWith('*')) {
      // Prefix match
      const prefix = publicPath.slice(0, -1);
      if (path.startsWith(prefix)) return true;
    } else {
      // Exact match
      if (path === publicPath) return true;
    }
  }
  return false;
}

/**
 * Utility to compose multiple middleware functions into a single middleware.
 */
export function composeMiddleware(...middlewares: Middleware[]): Middleware {
  return async (req, res, next) => {
    let index = -1;

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      if (i === middlewares.length) {
        return next();
      }

      const middleware = middlewares[i]!;
      return middleware(req, res, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}
