import { CrossTenantAccessError } from '../errors.js';
import { TenantContext } from '../tenant/context.js';
import type { TenantPool } from './pool.js';

/**
 * Tenant-safe query builder that automatically scopes queries to the current
 * tenant's schema using AsyncLocalStorage context.
 *
 * Prevents cross-tenant data access by enforcing that queries run against
 * the correct schema without manual intervention.
 */
export class TenantQuery {
  constructor(private readonly pool: TenantPool) {}

  /**
   * Execute a query scoped to the current tenant (from AsyncLocalStorage).
   * Throws NoTenantContextError if no tenant is in context.
   */
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const tenant = TenantContext.current();
    return this.queryAs<T>(tenant.id, sql, params);
  }

  /**
   * Execute a query explicitly scoped to a specific tenant.
   * If a tenant context is active, validates that the requested tenant matches
   * the current context (unless allowCrossTenant is true).
   *
   * Use this for admin operations that need to query a specific tenant's data.
   */
  async queryAs<T>(
    tenantId: string,
    sql: string,
    params?: unknown[],
    options?: { allowCrossTenant?: boolean },
  ): Promise<T[]> {
    // Guard against cross-tenant access
    if (!options?.allowCrossTenant) {
      const currentTenant = TenantContext.currentOrNull();
      if (currentTenant && currentTenant.id !== tenantId) {
        throw new CrossTenantAccessError(tenantId, currentTenant.id);
      }
    }

    const client = await this.pool.getConnection(tenantId);
    try {
      const result = await client.query(sql, params);
      return result.rows as T[];
    } finally {
      client.release();
    }
  }

  /**
   * Execute a function within a transaction scoped to the current tenant.
   * All queries within the callback share the same transaction.
   */
  async transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    const tenant = TenantContext.current();
    return this.transactionAs<T>(tenant.id, fn);
  }

  /**
   * Execute a function within a transaction for a specific tenant.
   */
  async transactionAs<T>(
    tenantId: string,
    fn: (tx: TransactionScope) => Promise<T>,
    options?: { allowCrossTenant?: boolean },
  ): Promise<T> {
    if (!options?.allowCrossTenant) {
      const currentTenant = TenantContext.currentOrNull();
      if (currentTenant && currentTenant.id !== tenantId) {
        throw new CrossTenantAccessError(tenantId, currentTenant.id);
      }
    }

    return this.pool.transaction(tenantId, async (client) => {
      const scope: TransactionScope = {
        async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
          const result = await client.query(sql, params);
          return result.rows as R[];
        },
        client,
      };
      return fn(scope);
    });
  }
}

/**
 * A scoped transaction handle passed to transaction callbacks.
 * All queries through this scope share the same database transaction.
 */
export interface TransactionScope {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Direct access to the underlying PoolClient for advanced usage */
  readonly client: import('pg').PoolClient;
}
