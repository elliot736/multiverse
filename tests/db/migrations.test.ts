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
