import { describe, it, expect, vi } from 'vitest';
import { TenantQuery } from '../../src/db/query.js';
import { TenantContext } from '../../src/tenant/context.js';
import type { Tenant } from '../../src/tenant/context.js';
import { TenantPool } from '../../src/db/pool.js';
import { CrossTenantAccessError, NoTenantContextError } from '../../src/errors.js';

function makeTenant(id: string): Tenant {
  return {
    id,
    name: `Tenant ${id}`,
    slug: id,
    tier: 'professional',
    status: 'active',
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createMockClient(rows: unknown[] = []) {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    release: vi.fn(),
  };
}

function createMockPool(client: ReturnType<typeof createMockClient>) {
  const pool = {
    getConnection: vi.fn(async () => client),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: vi.fn(async (_tenantId: string, fn: (c: any) => Promise<any>) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }),
  } as unknown as TenantPool;
  return pool;
}

describe('TenantQuery', () => {
  describe('query (auto-scoped)', () => {
    it('queries with the current tenant context', async () => {
      const mockClient = createMockClient([{ id: 1, name: 'Widget' }]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      const result = await TenantContext.run(tenant, () =>
        tq.query('SELECT * FROM products WHERE id = $1', [1]),
      );

      expect(result).toEqual([{ id: 1, name: 'Widget' }]);
      expect(pool.getConnection).toHaveBeenCalledWith('acme');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('throws when no tenant context is active', async () => {
      const pool = createMockPool(createMockClient());
      const tq = new TenantQuery(pool);

      await expect(tq.query('SELECT 1')).rejects.toThrow(NoTenantContextError);
    });

    it('passes params correctly', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, () =>
        tq.query('SELECT * FROM users WHERE active = $1 AND role = $2', [true, 'admin']),
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE active = $1 AND role = $2',
        [true, 'admin'],
      );
    });

    it('releases client even on query error', async () => {
      const mockClient = createMockClient();
      mockClient.query.mockRejectedValueOnce(new Error('query failed'));
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await expect(
        TenantContext.run(tenant, () => tq.query('BAD SQL')),
      ).rejects.toThrow('query failed');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('handles queries with no params', async () => {
      const mockClient = createMockClient([{ count: 5 }]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      const result = await TenantContext.run(tenant, () =>
        tq.query('SELECT count(*) FROM users'),
      );

      expect(result).toEqual([{ count: 5 }]);
    });

    it('handles null and undefined parameter values', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, () =>
        tq.query('INSERT INTO data (a, b) VALUES ($1, $2)', [null, undefined]),
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO data (a, b) VALUES ($1, $2)',
        [null, undefined],
      );
    });
  });

  describe('queryAs (explicit tenant)', () => {
    it('queries the specified tenant schema', async () => {
      const mockClient = createMockClient([{ count: 42 }]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const result = await tq.queryAs('globex', 'SELECT count(*) FROM users');
      expect(result).toEqual([{ count: 42 }]);
      expect(pool.getConnection).toHaveBeenCalledWith('globex');
    });

    it('prevents cross-tenant access by default', async () => {
      const pool = createMockPool(createMockClient());
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await expect(
        TenantContext.run(tenant, () => tq.queryAs('globex', 'SELECT 1')),
      ).rejects.toThrow(CrossTenantAccessError);
    });

    it('cross-tenant error has correct properties', async () => {
      const pool = createMockPool(createMockClient());
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      try {
        await TenantContext.run(tenant, () => tq.queryAs('globex', 'SELECT 1'));
      } catch (err) {
        expect(err).toBeInstanceOf(CrossTenantAccessError);
        expect((err as CrossTenantAccessError).requestedTenantId).toBe('globex');
        expect((err as CrossTenantAccessError).currentTenantId).toBe('acme');
        expect((err as CrossTenantAccessError).code).toBe('CROSS_TENANT_ACCESS');
      }
    });

    it('allows cross-tenant access with explicit opt-in', async () => {
      const mockClient = createMockClient([{ id: 'x' }]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      const result = await TenantContext.run(tenant, () =>
        tq.queryAs('globex', 'SELECT 1', [], { allowCrossTenant: true }),
      );
      expect(result).toEqual([{ id: 'x' }]);
    });

    it('allows queryAs when no tenant context is active', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      await tq.queryAs('acme', 'SELECT 1');
      expect(pool.getConnection).toHaveBeenCalledWith('acme');
    });

    it('allows queryAs for same tenant as context', async () => {
      const mockClient = createMockClient([{ id: 1 }]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      const result = await TenantContext.run(tenant, () =>
        tq.queryAs('acme', 'SELECT 1'),
      );
      expect(result).toEqual([{ id: 1 }]);
    });
  });

  describe('transaction', () => {
    it('executes within a transaction scoped to current tenant', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, () =>
        tq.transaction(async (tx) => {
          await tx.query('INSERT INTO orders (id) VALUES ($1)', ['ord-1']);
          await tx.query('INSERT INTO order_items (order_id) VALUES ($1)', ['ord-1']);
        }),
      );

      expect(pool.transaction).toHaveBeenCalledWith('acme', expect.any(Function));
    });

    it('provides access to the underlying client', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, () =>
        tq.transaction(async (tx) => {
          expect(tx.client).toBeDefined();
        }),
      );
    });

    it('throws when no tenant context is active', async () => {
      const pool = createMockPool(createMockClient());
      const tq = new TenantQuery(pool);

      await expect(
        tq.transaction(async () => {}),
      ).rejects.toThrow(NoTenantContextError);
    });

    it('returns value from transaction', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      const result = await TenantContext.run(tenant, () =>
        tq.transaction(async (_tx) => {
          return { success: true };
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe('transactionAs', () => {
    it('prevents cross-tenant transactions', async () => {
      const pool = createMockPool(createMockClient());
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await expect(
        TenantContext.run(tenant, () =>
          tq.transactionAs('globex', async () => {}),
        ),
      ).rejects.toThrow(CrossTenantAccessError);
    });

    it('allows cross-tenant transactions with opt-in', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, () =>
        tq.transactionAs('globex', async () => {}, { allowCrossTenant: true }),
      );
    });

    it('allows transactionAs for same tenant as context', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, () =>
        tq.transactionAs('acme', async () => {}),
      );
      expect(pool.transaction).toHaveBeenCalledWith('acme', expect.any(Function));
    });

    it('works without tenant context', async () => {
      const mockClient = createMockClient([]);
      const pool = createMockPool(mockClient);
      const tq = new TenantQuery(pool);

      await tq.transactionAs('acme', async () => {});
      expect(pool.transaction).toHaveBeenCalledWith('acme', expect.any(Function));
    });
  });
});
