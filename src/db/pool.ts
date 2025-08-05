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
