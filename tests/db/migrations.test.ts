import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantMigrator } from '../../src/db/migrations.js';
import { TenantPool } from '../../src/db/pool.js';
import { MigrationError } from '../../src/errors.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

function createMockClient(existingMigrations: string[] = []) {
  const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executedQueries.push({ sql, params });
      if (sql.includes('SELECT name FROM _migrations')) {
        return { rows: existingMigrations.map((n) => ({ name: n })), rowCount: existingMigrations.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _executedQueries: executedQueries,
  };
}

describe('TenantMigrator', () => {
  let migrationsDir: string;

  beforeEach(async () => {
    migrationsDir = path.join(tmpdir(), `mv-test-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(migrationsDir, { recursive: true });
  });

  function createMockPool(client: ReturnType<typeof createMockClient>) {
    return {
      getConnection: vi.fn(async () => client),
      queryPublic: vi.fn(async () => []),
      transaction: vi.fn(),
      close: vi.fn(),
      getPool: vi.fn(),
    } as unknown as TenantPool;
  }

  describe('migrate', () => {
    it('runs pending migrations in order', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_create_users.sql'), 'CREATE TABLE users (id TEXT)');
      await fs.writeFile(path.join(migrationsDir, '002_create_orders.sql'), 'CREATE TABLE orders (id TEXT)');

      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');

      const insertQueries = client._executedQueries.filter(
        (q) => q.sql.includes('INSERT INTO _migrations'),
      );
      expect(insertQueries).toHaveLength(2);
      expect(insertQueries[0]!.params).toEqual(['001_create_users.sql']);
      expect(insertQueries[1]!.params).toEqual(['002_create_orders.sql']);
    });

    it('skips already-executed migrations', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_create_users.sql'), 'CREATE TABLE users (id TEXT)');
      await fs.writeFile(path.join(migrationsDir, '002_create_orders.sql'), 'CREATE TABLE orders (id TEXT)');

      const client = createMockClient(['001_create_users.sql']);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');

      const insertQueries = client._executedQueries.filter(
        (q) => q.sql.includes('INSERT INTO _migrations'),
      );
      expect(insertQueries).toHaveLength(1);
      expect(insertQueries[0]!.params).toEqual(['002_create_orders.sql']);
    });

    it('is idempotent -- re-running with all migrations applied does nothing', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_init.sql'), 'CREATE TABLE t (id TEXT)');

      const client = createMockClient(['001_init.sql']);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');

      const insertQueries = client._executedQueries.filter(
        (q) => q.sql.includes('INSERT INTO _migrations'),
      );
      expect(insertQueries).toHaveLength(0);
    });

    it('handles empty migrations directory', async () => {
      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');
    });

    it('handles non-existent migrations directory', async () => {
      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, '/nonexistent/path');

      await migrator.migrate('acme');
    });

    it('only processes .sql files', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_create_users.sql'), 'CREATE TABLE users (id TEXT)');
      await fs.writeFile(path.join(migrationsDir, 'README.md'), '# Migrations');
      await fs.writeFile(path.join(migrationsDir, '.DS_Store'), '');
      await fs.writeFile(path.join(migrationsDir, 'helper.ts'), 'export const x = 1;');

      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');

      const insertQueries = client._executedQueries.filter(
        (q) => q.sql.includes('INSERT INTO _migrations'),
      );
      expect(insertQueries).toHaveLength(1);
    });

    it('wraps each migration in a transaction', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_init.sql'), 'CREATE TABLE t (id TEXT)');

      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');

      const queries = client._executedQueries.map((q) => q.sql);
      const beginIdx = queries.indexOf('BEGIN');
      const commitIdx = queries.indexOf('COMMIT');
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(commitIdx).toBeGreaterThan(beginIdx);
    });

    it('rolls back on migration failure', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_bad.sql'), 'INVALID SQL');

      const client = createMockClient([]);
      client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        client._executedQueries.push({ sql, params });
        if (sql === 'INVALID SQL') throw new Error('syntax error');
        if (sql.includes('SELECT name FROM _migrations')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });

      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await expect(migrator.migrate('acme')).rejects.toThrow(MigrationError);

      const queries = client._executedQueries.map((q) => q.sql);
      expect(queries).toContain('ROLLBACK');
    });

    it('MigrationError has correct properties', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_bad.sql'), 'INVALID SQL');

      const client = createMockClient([]);
      client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        client._executedQueries.push({ sql, params });
        if (sql === 'INVALID SQL') throw new Error('syntax error');
        if (sql.includes('SELECT name FROM _migrations')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });

      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      try {
        await migrator.migrate('acme');
      } catch (err) {
        expect(err).toBeInstanceOf(MigrationError);
        expect((err as MigrationError).tenantId).toBe('acme');
        expect((err as MigrationError).migration).toBe('001_bad.sql');
        expect((err as MigrationError).code).toBe('MIGRATION_ERROR');
      }
    });

    it('sorts migrations alphabetically', async () => {
      await fs.writeFile(path.join(migrationsDir, '003_third.sql'), 'SELECT 3');
      await fs.writeFile(path.join(migrationsDir, '001_first.sql'), 'SELECT 1');
      await fs.writeFile(path.join(migrationsDir, '002_second.sql'), 'SELECT 2');

      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');

      const insertQueries = client._executedQueries.filter(
        (q) => q.sql.includes('INSERT INTO _migrations'),
      );
      expect(insertQueries.map((q) => q.params![0])).toEqual([
        '001_first.sql',
        '002_second.sql',
        '003_third.sql',
      ]);
    });

    it('releases client after successful migration', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_init.sql'), 'SELECT 1');

      const client = createMockClient([]);
      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      await migrator.migrate('acme');
      expect(client.release).toHaveBeenCalled();
    });

    it('releases client after failed migration', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_bad.sql'), 'FAIL');

      const client = createMockClient([]);
      client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        client._executedQueries.push({ sql, params });
        if (sql === 'FAIL') throw new Error('fail');
        if (sql.includes('SELECT name FROM _migrations')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });

      const pool = createMockPool(client);
      const migrator = new TenantMigrator(pool, migrationsDir);

      try { await migrator.migrate('acme'); } catch { /* expected */ }
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('provision', () => {
    it('creates schema and outbox table', async () => {
      const client = createMockClient([]);
      const pool = createMockPool(client);
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      await migrator.provision('newco');

      expect(pool.queryPublic).toHaveBeenCalledWith(
        'CREATE SCHEMA IF NOT EXISTS "tenant_newco"',
      );

      const queries = client._executedQueries.map((q) => q.sql);
      expect(queries.some((q) => q.includes('_outbox'))).toBe(true);
      expect(queries.some((q) => q.includes('_migrations'))).toBe(true);
    });

    it('creates outbox index', async () => {
      const client = createMockClient([]);
      const pool = createMockPool(client);
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      await migrator.provision('newco');

      const queries = client._executedQueries.map((q) => q.sql);
      expect(queries.some((q) => q.includes('idx_outbox_undelivered'))).toBe(true);
    });

    it('runs migrations after creating schema', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_init.sql'), 'SELECT 1');

      const client = createMockClient([]);
      const pool = createMockPool(client);
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      await migrator.provision('newco');

      const insertQueries = client._executedQueries.filter(
        (q) => q.sql.includes('INSERT INTO _migrations'),
      );
      expect(insertQueries).toHaveLength(1);
    });
  });

  describe('deprovision', () => {
    it('drops the tenant schema', async () => {
      const client = createMockClient([]);
      const pool = createMockPool(client);
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      await migrator.deprovision('oldco');

      expect(pool.queryPublic).toHaveBeenCalledWith(
        'DROP SCHEMA IF EXISTS "tenant_oldco" CASCADE',
      );
    });
  });

  describe('migrateAll', () => {
    it('discovers and migrates all tenant schemas', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_init.sql'), 'SELECT 1');

      const client = createMockClient([]);
      const pool = createMockPool(client);

      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { schema_name: 'tenant_acme' },
        { schema_name: 'tenant_globex' },
      ]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      const result = await migrator.migrateAll();

      expect(result.succeeded).toEqual(['acme', 'globex']);
      expect(result.failed).toHaveLength(0);
    });

    it('reports failures per tenant without stopping', async () => {
      await fs.writeFile(path.join(migrationsDir, '001_init.sql'), 'CREATE TABLE t (id TEXT)');

      let callCount = 0;
      const client = createMockClient([]);
      client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        client._executedQueries.push({ sql, params });
        if (sql.includes('SELECT name FROM _migrations')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'CREATE TABLE t (id TEXT)') {
          callCount++;
          if (callCount === 1) throw new Error('disk full');
        }
        return { rows: [], rowCount: 0 };
      });

      const pool = createMockPool(client);
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { schema_name: 'tenant_failing' },
        { schema_name: 'tenant_ok' },
      ]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      const result = await migrator.migrateAll();

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.tenantId).toBe('failing');
      expect(result.succeeded).toContain('ok');
    });

    it('handles empty schema list', async () => {
      const client = createMockClient([]);
      const pool = createMockPool(client);
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const migrator = new TenantMigrator(pool, migrationsDir);
      const result = await migrator.migrateAll();

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([]);
    });
  });
});
