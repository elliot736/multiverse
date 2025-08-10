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
