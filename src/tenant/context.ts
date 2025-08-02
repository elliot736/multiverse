import { AsyncLocalStorage } from 'node:async_hooks';
import { NoTenantContextError } from '../errors.js';

/**
 * Represents a tenant in the system.
 */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  tier: 'free' | 'starter' | 'professional' | 'enterprise';
  status: 'active' | 'suspended' | 'provisioning';
  config: TenantConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantConfig {
  /** Custom rate limit overrides per tier */
  rateLimitOverrides?: {
    requestsPerSecond?: number;
    burstCapacity?: number;
  };
  /** Per-tenant OIDC provider configuration */
  oidc?: {
    issuer: string;
    jwksUri: string;
    audience: string;
  };
  /** Arbitrary tenant-specific configuration */
  [key: string]: unknown;
}

/**
 * TenantContext uses AsyncLocalStorage to propagate the current tenant
 * implicitly through the call stack without explicit parameter passing.
 *
 * Usage:
 * ```
 * TenantContext.run(tenant, () => {
 *   // Anywhere in this call tree:
 *   const t = TenantContext.current(); // returns the tenant
 * });
 * ```
 */
export class TenantContext {
  private static storage = new AsyncLocalStorage<Tenant>();

  /**
   * Execute a function within a tenant context. All code executed within `fn`
   * (including async operations) will have access to the tenant via `current()`.
   */
  static run<T>(tenant: Tenant, fn: () => T): T {
    return TenantContext.storage.run(tenant, fn);
  }

  /**
   * Get the current tenant. Throws NoTenantContextError if called outside
   * a TenantContext.run() scope.
   */
  static current(): Tenant {
    const tenant = TenantContext.storage.getStore();
    if (!tenant) {
      throw new NoTenantContextError();
    }
    return tenant;
  }

  /**
   * Get the current tenant, or null if no tenant context is active.
   * Useful for code that may run both inside and outside a tenant context
   * (e.g., logging).
   */
  static currentOrNull(): Tenant | null {
    return TenantContext.storage.getStore() ?? null;
  }

  /**
   * Get the current tenant's schema name.
   * Convention: tenant_{id}
   */
  static schemaName(): string {
    return `tenant_${TenantContext.current().id}`;
  }
}
