import { describe, it, expect } from 'vitest';
import { TenantContext } from '../../src/tenant/context.js';
import type { Tenant } from '../../src/tenant/context.js';
import { NoTenantContextError } from '../../src/errors.js';

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'acme',
    name: 'Acme Corp',
    slug: 'acme',
    tier: 'professional',
    status: 'active',
    config: {},
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('TenantContext', () => {
  describe('run and current', () => {
    it('provides the tenant within the run callback', () => {
      const tenant = makeTenant();
      TenantContext.run(tenant, () => {
        expect(TenantContext.current()).toBe(tenant);
      });
    });

    it('returns the correct tenant for synchronous code', () => {
      const tenant = makeTenant({ id: 'sync-test' });
      const result = TenantContext.run(tenant, () => {
        return TenantContext.current().id;
      });
      expect(result).toBe('sync-test');
    });

    it('returns the correct tenant for async code', async () => {
      const tenant = makeTenant({ id: 'async-test' });
      const result = await TenantContext.run(tenant, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return TenantContext.current().id;
      });
      expect(result).toBe('async-test');
    });

    it('supports nested contexts (inner overrides outer)', () => {
      const outer = makeTenant({ id: 'outer' });
      const inner = makeTenant({ id: 'inner' });

      TenantContext.run(outer, () => {
        expect(TenantContext.current().id).toBe('outer');
        TenantContext.run(inner, () => {
          expect(TenantContext.current().id).toBe('inner');
        });
        // After inner exits, outer is restored
        expect(TenantContext.current().id).toBe('outer');
      });
    });

    it('supports deeply nested run() calls', () => {
      const tenants = ['a', 'b', 'c', 'd', 'e'].map((id) => makeTenant({ id }));
      const observed: string[] = [];

      TenantContext.run(tenants[0]!, () => {
        observed.push(TenantContext.current().id);
        TenantContext.run(tenants[1]!, () => {
          observed.push(TenantContext.current().id);
          TenantContext.run(tenants[2]!, () => {
            observed.push(TenantContext.current().id);
            TenantContext.run(tenants[3]!, () => {
              observed.push(TenantContext.current().id);
              TenantContext.run(tenants[4]!, () => {
                observed.push(TenantContext.current().id);
              });
              observed.push(TenantContext.current().id);
            });
            observed.push(TenantContext.current().id);
          });
          observed.push(TenantContext.current().id);
        });
        observed.push(TenantContext.current().id);
      });

      expect(observed).toEqual(['a', 'b', 'c', 'd', 'e', 'd', 'c', 'b', 'a']);
    });

    it('isolates concurrent async contexts', async () => {
      const tenantA = makeTenant({ id: 'tenant-a' });
      const tenantB = makeTenant({ id: 'tenant-b' });

      const results = await Promise.all([
        TenantContext.run(tenantA, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return TenantContext.current().id;
        }),
        TenantContext.run(tenantB, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return TenantContext.current().id;
        }),
      ]);

      expect(results).toEqual(['tenant-a', 'tenant-b']);
    });

    it('isolates many concurrent async contexts', async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `tenant-${i}`);
      const tenants = ids.map((id) => makeTenant({ id }));

      const results = await Promise.all(
        tenants.map((tenant) =>
          TenantContext.run(tenant, async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 30));
            return TenantContext.current().id;
          }),
        ),
      );

      expect(results).toEqual(ids);
    });

    it('propagates context through Promise chains', async () => {
      const tenant = makeTenant({ id: 'promise-chain' });

      const result = await TenantContext.run(tenant, async () => {
        return Promise.resolve()
          .then(() => TenantContext.current().id)
          .then((id) => {
            expect(id).toBe('promise-chain');
            return Promise.resolve().then(() => TenantContext.current().id);
          });
