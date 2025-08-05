import type { Pool, PoolClient, PoolConfig } from 'pg';

/**
 * Tenant-scoped connection pool manager.
 *
 * Wraps a standard pg Pool and ensures every connection has its search_path
 * set to the appropriate tenant schema before being used. This enforces
 * schema-per-tenant isolation at the connection level.
 */
export class TenantPool {
  private pool: Pool | null = null;
  private readonly config: PoolConfig;
  private poolFactory: (config: PoolConfig) => Pool;

  constructor(config: PoolConfig, poolFactory?: (config: PoolConfig) => Pool) {
    this.config = config;
    // Allow injection of pool factory for testing
    this.poolFactory = poolFactory ?? ((c: PoolConfig) => {
      // Dynamic import to avoid hard dependency at module level
      const pg = require('pg') as { Pool: new (config: PoolConfig) => Pool };
      return new pg.Pool(c);
    });
  }

  /**
   * Get the underlying pool, creating it lazily.
   */
  getPool(): Pool {
    if (!this.pool) {
      this.pool = this.poolFactory(this.config);
    }
    return this.pool;
  }

  /**
   * Get a connection scoped to a tenant's schema.
   * Sets `search_path` to `tenant_{tenantId}, public` so that all
   * unqualified table references resolve to the tenant's schema.
   *
   * IMPORTANT: The caller must release the client when done.
   */
  async getConnection(tenantId: string): Promise<PoolClient> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      const schemaName = `tenant_${tenantId}`;
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
      return client;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /**
   * Execute a function within a transaction scoped to a tenant's schema.
   * The transaction is automatically committed on success or rolled back on error.
   * The client is released after the transaction completes.
   */
  async transaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getConnection(tenantId);
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Execute a raw query on the public schema (no tenant scoping).
   * Used for admin operations like listing tenants.
   */
  async queryPublic<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const pool = this.getPool();
    const result = await pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Shut down the pool.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

/**
 * Quote a SQL identifier to prevent injection.
 * Postgres identifiers are quoted with double quotes.
 */
function quoteIdentifier(identifier: string): string {
  // Only allow alphanumeric and underscores in schema names
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
