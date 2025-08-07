import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MigrationError } from '../errors.js';
import type { TenantPool } from './pool.js';

interface MigrationRecord {
  name: string;
  executed_at: Date;
}

/**
 * Per-tenant schema migration runner.
 *
 * Manages schema creation, migration tracking, and execution for each tenant.
 * Migrations are SQL files stored in a directory, executed in alphabetical order.
 * Each tenant schema has a `_migrations` table tracking which migrations have been applied.
 */
export class TenantMigrator {
  constructor(
    private readonly pool: TenantPool,
    private readonly migrationsDir: string,
  ) {}

  /**
   * Provision a new tenant: create schema, migrations table, outbox table,
   * and run all pending migrations.
   */
  async provision(tenantId: string): Promise<void> {
    const schemaName = `tenant_${tenantId}`;

    // Create schema
    await this.pool.queryPublic(
      `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`,
    );

    // Create migrations tracking table
    const client = await this.pool.getConnection(tenantId);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // Create outbox table (required by the transactional outbox pattern)
      await client.query(`
        CREATE TABLE IF NOT EXISTS _outbox (
          id BIGSERIAL PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload JSONB NOT NULL,
          idempotency_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          delivered_at TIMESTAMPTZ,
          retry_count INT NOT NULL DEFAULT 0
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_outbox_undelivered
        ON _outbox (id) WHERE delivered_at IS NULL
      `);
    } finally {
      client.release();
    }

    // Run all migrations
    await this.migrate(tenantId);
  }

  /**
   * Run all pending migrations for a specific tenant.
   */
  async migrate(tenantId: string): Promise<void> {
    const allMigrations = await this.loadMigrations();
    if (allMigrations.length === 0) return;

    const client = await this.pool.getConnection(tenantId);
    try {
      // Ensure migrations table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // Get already-executed migrations
      const result = await client.query('SELECT name FROM _migrations ORDER BY name');
      const executed = new Set(
        (result.rows as MigrationRecord[]).map((r) => r.name),
      );

      // Run pending migrations in order
      for (const migration of allMigrations) {
        if (executed.has(migration.name)) continue;

        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO _migrations (name) VALUES ($1)',
            [migration.name],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new MigrationError(
            tenantId,
            migration.name,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      client.release();
    }
  }

  /**
   * Run pending migrations for ALL tenant schemas.
   * Discovers tenant schemas by querying information_schema.
   */
  async migrateAll(): Promise<MigrateAllResult> {
    const schemas = await this.pool.queryPublic<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'tenant_%'
       ORDER BY schema_name`,
    );

    const result: MigrateAllResult = {
      succeeded: [],
      failed: [],
    };

    for (const schema of schemas) {
      const tenantId = schema.schema_name.replace(/^tenant_/, '');
      try {
        await this.migrate(tenantId);
        result.succeeded.push(tenantId);
      } catch (err) {
        result.failed.push({
          tenantId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return result;
  }

  /**
   * Drop a tenant's schema entirely. Use with extreme caution.
   */
  async deprovision(tenantId: string): Promise<void> {
    const schemaName = `tenant_${tenantId}`;
    await this.pool.queryPublic(
      `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
    );
  }

  /**
   * Load migration files from the migrations directory, sorted by name.
   */
  private async loadMigrations(): Promise<Migration[]> {
    let entries: string[];
    try {
      entries = await readdir(this.migrationsDir);
    } catch {
      return [];
    }

    const sqlFiles = entries
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const migrations: Migration[] = [];
    for (const file of sqlFiles) {
      const sql = await readFile(join(this.migrationsDir, file), 'utf-8');
      migrations.push({ name: file, sql });
    }

    return migrations;
  }
}

interface Migration {
  name: string;
  sql: string;
}

export interface MigrateAllResult {
  succeeded: string[];
  failed: Array<{ tenantId: string; error: Error }>;
}
