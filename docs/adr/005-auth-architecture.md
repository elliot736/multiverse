# ADR-005: Auth Architecture

## Status

Accepted

## Date

2025-08-24

## Context

Authentication in a multi-tenant system is more complex than single-tenant auth:

1. **Users belong to tenants.** A user's identity is scoped to a tenant. The same email might exist in two different tenants as two different users.
2. **JWTs must carry tenant context.** The access token must indicate which tenant the user is acting on behalf of. This is typically a custom claim (e.g., `tenant_id`).
3. **OIDC providers may vary per tenant.** Some SaaS platforms use a single identity provider (Auth0, Keycloak) for all tenants. Others allow enterprise tenants to bring their own IdP (Okta, Azure AD) for SSO. The framework must support both models.
4. **Tenant-scoped authorization.** Even after authentication, the framework must verify that the authenticated user is authorized for the tenant identified by the request. A valid JWT issued for tenant A must not grant access to tenant B's resources.

We are not building an auth server. The framework delegates authentication to external identity providers and focuses on validating tokens and enforcing tenant scoping.

## Decision

### JWT-Based Authentication

The auth middleware validates JWTs using the JOSE library:

1. Extract the `Authorization: Bearer <token>` header.
2. Fetch the JWKS (JSON Web Key Set) from the configured OIDC provider's `jwks_uri`. Keys are cached.
3. Verify the JWT signature, expiration, issuer, and audience.
4. Extract the tenant claim (configurable, default `tenant_id`).
5. Validate that the tenant claim matches the resolved tenant (from the `TenantResolver`). If they differ, reject the request with a `CrossTenantAccessError`.

### Two Provider Models

**Shared provider** (default): A single OIDC provider serves all tenants. The framework is configured with a single `jwksUri`, `issuer`, and `audience`. The tenant is distinguished by a claim in the JWT.

**Per-tenant provider**: Each tenant can configure its own OIDC provider. The `TenantRegistry` stores the provider configuration (issuer, JWKS URI, audience) per tenant. When a request arrives, the framework looks up the provider for the resolved tenant and validates the JWT accordingly. This enables enterprise SSO scenarios where tenants use their own Okta/Azure AD.

### Middleware, Not Auth Server

The framework provides:
- JWT validation middleware
- Tenant claim cross-referencing
- JWKS caching and rotation handling
- Types for authenticated users (`TenantUser`)

The framework does NOT provide:
- User registration or login flows
- Token issuance
- Password management
- Session management

These are the responsibility of the external identity provider.

## Trade-offs

### Advantages

- **Minimal surface area.** By delegating to external IdPs, the framework avoids the complexity and security responsibility of managing credentials.
- **Standards-based.** OIDC/JWT is the industry standard. Developers can use any compliant IdP.
- **Flexible.** Shared provider is simple to set up. Per-tenant provider supports enterprise SSO without framework changes.
- **Cross-tenant protection.** The tenant claim validation is a defense-in-depth measure. Even if a user has a valid JWT, they cannot access a tenant they do not belong to.

### Disadvantages

- **Requires external IdP.** The framework cannot be used standalone for auth. Developers must set up Auth0, Keycloak, or another OIDC provider. For prototyping, we provide a `skipAuth` option in development mode.
- **JWT-only.** Session-based auth (cookies) is not natively supported. This is intentional: JWTs are better suited for API-first multi-tenant architectures, but it limits use cases with traditional server-rendered applications.
- **JWKS fetching adds latency.** The first request after startup or key rotation requires fetching the JWKS. We mitigate this by caching keys and supporting eager pre-fetching.

## Consequences

1. The auth middleware must run after tenant resolution (it needs the tenant ID to cross-reference the JWT claim) but before the request handler.
2. The `TenantUser` type carries both the user identity and the tenant identity, making it easy for application code to access both.
3. Per-tenant OIDC configuration is stored in the `TenantRegistry`. Adding a new field to the `Tenant` type is necessary.
4. The framework must handle JWKS rotation gracefully (re-fetch on `kid` mismatch).
5. The `AuthConfig` must support both provider models via a single configuration object.
