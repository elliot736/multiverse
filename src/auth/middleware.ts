import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthenticationError, CrossTenantAccessError } from '../errors.js';
import { TenantContext } from '../tenant/context.js';
import type { TenantRegistry } from '../tenant/registry.js';
import type { Middleware } from '../http/types.js';
import type { AuthConfig, TenantUser, TenantOidcConfig } from './types.js';
import { verifyToken, decodeToken } from './oidc.js';

/**
 * Create auth middleware that validates JWTs and enforces tenant scoping.
 *
 * The middleware:
 * 1. Extracts the Bearer token from the Authorization header
 * 2. Verifies the JWT signature, expiration, issuer, and audience
 * 3. Extracts the tenant claim and validates it matches the resolved tenant
 * 4. Attaches the authenticated TenantUser to the request
 */
export function authMiddleware(
  config: AuthConfig,
  registry?: TenantRegistry,
): Middleware {
  const tenantClaim = config.tenantClaim ?? 'tenant_id';
  const rolesClaim = config.rolesClaim ?? 'roles';

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>,
  ): Promise<void> => {
    // Skip auth in development mode
    if (config.skipAuth) {
      const tenant = TenantContext.currentOrNull();
      const mockUser: TenantUser = {
        sub: 'dev-user',
        tenantId: tenant?.id ?? 'unknown',
        email: 'dev@localhost',
        name: 'Development User',
        roles: ['admin'],
        claims: {},
      };
      (req as AuthenticatedRequest).user = mockUser;
      return next();
    }

    // Extract token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
      return;
    }

    const token = authHeader.slice(7);

    try {
      // Determine OIDC config
      const oidcConfig = await resolveOidcConfig(config, token, registry);

      // Verify the token
      const payload = await verifyToken(token, oidcConfig);

      // Extract tenant from JWT
      const jwtTenantId = payload[tenantClaim];
      if (typeof jwtTenantId !== 'string') {
        throw new AuthenticationError(
          `JWT missing required tenant claim: ${tenantClaim}`,
        );
      }

      // Cross-reference with resolved tenant
      const currentTenant = TenantContext.currentOrNull();
      if (currentTenant && currentTenant.id !== jwtTenantId) {
        throw new CrossTenantAccessError(jwtTenantId, currentTenant.id);
      }

      // Extract roles
      const rawRoles = payload[rolesClaim];
      let roles: string[] = [];
      if (Array.isArray(rawRoles)) {
        roles = rawRoles.filter((r): r is string => typeof r === 'string');
      } else if (typeof rawRoles === 'string') {
        roles = rawRoles.split(',').map((r) => r.trim());
      }

      // Build TenantUser
      const user: TenantUser = {
        sub: payload.sub ?? 'unknown',
        tenantId: jwtTenantId,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        roles,
        claims: payload,
      };

      (req as AuthenticatedRequest).user = user;
      return next();
    } catch (err) {
      if (err instanceof AuthenticationError) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (err instanceof CrossTenantAccessError) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal authentication error' }));
    }
  };
}

/**
 * Resolve the OIDC configuration for this request.
 * If perTenantProviders is enabled, looks up the config from the tenant registry.
 * Otherwise, uses the shared config.
 */
async function resolveOidcConfig(
  config: AuthConfig,
  token: string,
  registry?: TenantRegistry,
): Promise<TenantOidcConfig> {
  if (config.perTenantProviders && registry) {
    // Decode (not verify) the token to get the tenant claim
    const decoded = decodeToken(token);
    const tenantId = decoded[config.tenantClaim ?? 'tenant_id'];

    if (typeof tenantId !== 'string') {
      throw new AuthenticationError('Cannot determine tenant from token for per-tenant OIDC');
    }

    const tenant = await registry.get(tenantId);
    if (!tenant) {
      throw new AuthenticationError(`Unknown tenant: ${tenantId}`);
    }

    if (!tenant.config.oidc) {
      throw new AuthenticationError(`No OIDC configuration for tenant: ${tenantId}`);
    }

    return tenant.config.oidc as TenantOidcConfig;
  }

  // Shared provider
  if (!config.jwksUri) {
    throw new AuthenticationError('No JWKS URI configured');
  }

  return {
    jwksUri: config.jwksUri,
    issuer: config.issuer ?? '',
    audience: config.audience ?? '',
  };
}

/**
 * Express/Node request with an attached user.
 */
export interface AuthenticatedRequest extends IncomingMessage {
  user?: TenantUser;
}

/**
 * Extract the authenticated user from a request.
 * Returns null if the request has not been authenticated.
 */
export function getUser(req: IncomingMessage): TenantUser | null {
  return (req as AuthenticatedRequest).user ?? null;
}

/**
 * Extract the authenticated user from a request, throwing if not authenticated.
 */
export function requireUser(req: IncomingMessage): TenantUser {
  const user = getUser(req);
  if (!user) {
    throw new AuthenticationError('User not authenticated');
  }
  return user;
}
