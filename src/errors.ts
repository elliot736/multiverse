/**
 * Base error class for all Multiverse framework errors.
 */
export class MultiverseError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a tenant cannot be found in the registry.
 */
export class TenantNotFoundError extends MultiverseError {
  public readonly tenantId: string;

  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`, 'TENANT_NOT_FOUND');
    this.tenantId = tenantId;
  }
}

/**
 * Thrown when code attempts to access a tenant's data from a different tenant's context.
 */
export class CrossTenantAccessError extends MultiverseError {
  public readonly requestedTenantId: string;
  public readonly currentTenantId: string;

  constructor(requestedTenantId: string, currentTenantId: string) {
    super(
      `Cross-tenant access denied: attempted to access tenant "${requestedTenantId}" from context of tenant "${currentTenantId}"`,
      'CROSS_TENANT_ACCESS',
    );
    this.requestedTenantId = requestedTenantId;
    this.currentTenantId = currentTenantId;
  }
}

/**
 * Thrown when tenant context is required but not present (e.g., outside a request).
 */
export class NoTenantContextError extends MultiverseError {
  constructor() {
    super(
      'No tenant context available. Ensure this code is running within a TenantContext.run() scope.',
      'NO_TENANT_CONTEXT',
    );
  }
}

/**
 * Thrown when a rate limit is exceeded.
 */
export class RateLimitExceededError extends MultiverseError {
  public readonly tenantId: string;
  public readonly retryAfterMs: number;

  constructor(tenantId: string, retryAfterMs: number) {
    super(`Rate limit exceeded for tenant: ${tenantId}`, 'RATE_LIMIT_EXCEEDED');
    this.tenantId = tenantId;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown when an outbox event cannot be published.
 */
export class OutboxPublishError extends MultiverseError {
  public readonly originalError: Error;

  constructor(message: string, originalError: Error) {
    super(`Outbox publish failed: ${message}`, 'OUTBOX_PUBLISH_ERROR');
    this.originalError = originalError;
  }
}

/**
 * Thrown when authentication fails.
 */
export class AuthenticationError extends MultiverseError {
  constructor(message: string) {
    super(message, 'AUTHENTICATION_ERROR');
  }
}

/**
 * Thrown when a tenant cannot be resolved from the request.
 */
export class TenantResolutionError extends MultiverseError {
  constructor(message: string) {
    super(message, 'TENANT_RESOLUTION_ERROR');
  }
}

/**
 * Thrown when a migration fails.
 */
export class MigrationError extends MultiverseError {
  public readonly tenantId: string;
  public readonly migration: string;

  constructor(tenantId: string, migration: string, message: string) {
    super(`Migration failed for tenant "${tenantId}" (${migration}): ${message}`, 'MIGRATION_ERROR');
    this.tenantId = tenantId;
    this.migration = migration;
  }
}
