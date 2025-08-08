import type { JWTPayload } from 'jose';

/**
 * Represents an authenticated user within a tenant context.
 */
export interface TenantUser {
  /** User's unique identifier (from JWT `sub` claim) */
  sub: string;
  /** Tenant ID the user is acting on behalf of */
  tenantId: string;
  /** User's email (if present in JWT) */
  email?: string;
  /** User's display name (if present in JWT) */
  name?: string;
  /** Roles or scopes (if present in JWT) */
  roles: string[];
  /** Raw JWT claims for advanced usage */
  claims: JWTPayload;
}

/**
 * Configuration for the auth middleware.
 */
export interface AuthConfig {
  /** JWKS URI for fetching signing keys. Required unless perTenantProviders is true. */
  jwksUri?: string;
  /** Expected JWT issuer. */
  issuer?: string;
  /** Expected JWT audience. */
  audience?: string;
  /** JWT claim containing the tenant ID. Default: 'tenant_id' */
  tenantClaim?: string;
  /** JWT claim containing user roles. Default: 'roles' */
  rolesClaim?: string;
  /**
   * If true, look up OIDC config per tenant from the TenantRegistry.
   * Each tenant's config.oidc must contain issuer, jwksUri, and audience.
   */
  perTenantProviders?: boolean;
  /**
   * Skip authentication entirely. ONLY for development.
   * When true, all requests are treated as authenticated with a mock user.
   */
  skipAuth?: boolean;
}

/**
 * Per-tenant OIDC provider configuration, stored in TenantConfig.oidc.
 */
export interface TenantOidcConfig {
  issuer: string;
  jwksUri: string;
  audience: string;
}
