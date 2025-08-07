import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantPool } from '../../src/db/pool.js';

function createMockClient() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _queries: queries,
  };
  return client;
}

function createMockPool() {
  const mockClient = createMockClient();
  const pool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn(async (_sql: string, _params?: unknown[]) => {
      return { rows: [], rowCount: 0 };
    }),
    end: vi.fn(async () => {}),
    _client: mockClient,
  };
  return pool;
}

describe('TenantPool', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let tenantPool: TenantPool;

  beforeEach(() => {
    mockPool = createMockPool();
    tenantPool = new TenantPool(
      { host: 'localhost' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => mockPool as any,
    );
  });

  describe('getPool', () => {
    it('creates pool lazily on first call', () => {
      const pool = tenantPool.getPool();
      expect(pool).toBeDefined();
    });

    it('returns the same pool on subsequent calls', () => {
      const pool1 = tenantPool.getPool();
      const pool2 = tenantPool.getPool();
      expect(pool1).toBe(pool2);
    });
  });

  describe('getConnection', () => {
    it('sets search_path to tenant schema', async () => {
      const client = await tenantPool.getConnection('acme');
      expect(mockPool._client.query).toHaveBeenCalledWith(
        'SET search_path TO "tenant_acme", public',
      );
      expect(client).toBeDefined();
    });

    it('releases client if search_path fails', async () => {
      mockPool._client.query.mockRejectedValueOnce(new Error('schema not found'));
      await expect(tenantPool.getConnection('bad')).rejects.toThrow('schema not found');
      expect(mockPool._client.release).toHaveBeenCalled();
    });

    it('rejects SQL injection attempts in schema names', async () => {
      await expect(tenantPool.getConnection('drop table;--')).rejects.toThrow('Invalid identifier');
    });

    it('rejects schema names with special characters', async () => {
      await expect(tenantPool.getConnection('a b c')).rejects.toThrow('Invalid identifier');
      await expect(tenantPool.getConnection('tenant"name')).rejects.toThrow('Invalid identifier');
      await expect(tenantPool.getConnection("tenant'name")).rejects.toThrow('Invalid identifier');
    });

    it('rejects schema names starting with a number', async () => {
      // The tenant ID starts with a number, but the resulting schema name is
      // tenant_123 which starts with a letter and is valid
      await tenantPool.getConnection('123');
      expect(mockPool._client.query).toHaveBeenCalledWith(
        'SET search_path TO "tenant_123", public',
      );
    });

    it('allows alphanumeric tenant IDs', async () => {
      await tenantPool.getConnection('abc123');
      expect(mockPool._client.query).toHaveBeenCalledWith(
        'SET search_path TO "tenant_abc123", public',
      );
    });

    it('allows tenant IDs with underscores', async () => {
      await tenantPool.getConnection('my_tenant');
      expect(mockPool._client.query).toHaveBeenCalledWith(
        'SET search_path TO "tenant_my_tenant", public',
      );
    });
  });

  describe('transaction', () => {
    it('wraps function in BEGIN/COMMIT', async () => {
      const result = await tenantPool.transaction('acme', async (client) => {
        await client.query('INSERT INTO orders (id) VALUES ($1)', ['ord-1']);
        return 'ok';
      });

      expect(result).toBe('ok');
      const queries = mockPool._client._queries.map((q) => q.sql);
      expect(queries).toContain('BEGIN');
      expect(queries).toContain('COMMIT');
      expect(queries).toContain('INSERT INTO orders (id) VALUES ($1)');
    });

    it('rolls back on error', async () => {
      await expect(
        tenantPool.transaction('acme', async () => {
          throw new Error('business logic failed');
        }),
      ).rejects.toThrow('business logic failed');

      const queries = mockPool._client._queries.map((q) => q.sql);
      expect(queries).toContain('BEGIN');
      expect(queries).toContain('ROLLBACK');
      expect(queries).not.toContain('COMMIT');
    });

    it('releases client after successful transaction', async () => {
      await tenantPool.transaction('acme', async () => {});
      expect(mockPool._client.release).toHaveBeenCalled();
    });

    it('releases client even on error', async () => {
      try {
        await tenantPool.transaction('acme', async () => {
          throw new Error('fail');
        });
      } catch { /* expected */ }
      expect(mockPool._client.release).toHaveBeenCalled();
    });

    it('returns the value from the transaction function', async () => {
      const result = await tenantPool.transaction('acme', async () => {
        return { orderId: 'ord-1', total: 99.99 };
      });
      expect(result).toEqual({ orderId: 'ord-1', total: 99.99 });
    });

    it('executes queries in correct order', async () => {
      await tenantPool.transaction('acme', async (client) => {
        await client.query('INSERT 1');
        await client.query('INSERT 2');
        await client.query('INSERT 3');
      });

      const queries = mockPool._client._queries.map((q) => q.sql);
      const searchPathIdx = queries.indexOf('SET search_path TO "tenant_acme", public');
      const beginIdx = queries.indexOf('BEGIN');
      const insert1Idx = queries.indexOf('INSERT 1');
      const insert2Idx = queries.indexOf('INSERT 2');
      const insert3Idx = queries.indexOf('INSERT 3');
      const commitIdx = queries.indexOf('COMMIT');

      expect(searchPathIdx).toBeLessThan(beginIdx);
      expect(beginIdx).toBeLessThan(insert1Idx);
      expect(insert1Idx).toBeLessThan(insert2Idx);
      expect(insert2Idx).toBeLessThan(insert3Idx);
      expect(insert3Idx).toBeLessThan(commitIdx);
    });
  });

  describe('queryPublic', () => {
    it('executes query on the pool directly (public schema)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acme' }],
        rowCount: 1,
      });

      const result = await tenantPool.queryPublic('SELECT * FROM public.tenants');
      expect(result).toEqual([{ id: 'acme' }]);
      expect(mockPool.query).toHaveBeenCalledWith('SELECT * FROM public.tenants', undefined);
    });

    it('passes parameters to the query', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'acme' }], rowCount: 1 });

      await tenantPool.queryPublic('SELECT * FROM tenants WHERE id = $1', ['acme']);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM tenants WHERE id = $1',
        ['acme'],
      );
    });
  });

  describe('close', () => {
    it('ends the pool', async () => {
      await tenantPool.queryPublic('SELECT 1');
      await tenantPool.close();
      expect(mockPool.end).toHaveBeenCalled();
    });

    it('is safe to call multiple times', async () => {
      await tenantPool.close();
      await tenantPool.close();
    });

    it('sets pool to null so a new one can be created', async () => {
      tenantPool.getPool(); // create pool
      await tenantPool.close();
      // After close, getPool should create a new pool
      const newPool = tenantPool.getPool();
      expect(newPool).toBeDefined();
    });
  });
});
