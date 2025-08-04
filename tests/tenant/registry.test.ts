import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryTenantRegistry } from '../../src/tenant/registry.js';
import { TenantNotFoundError } from '../../src/errors.js';

describe('MemoryTenantRegistry', () => {
  let registry: MemoryTenantRegistry;

  beforeEach(() => {
    registry = new MemoryTenantRegistry();
  });

  describe('create', () => {
    it('creates a tenant with default values', async () => {
      const tenant = await registry.create({
        id: 'acme',
        name: 'Acme Corp',
        slug: 'acme',
      });

      expect(tenant.id).toBe('acme');
      expect(tenant.name).toBe('Acme Corp');
      expect(tenant.slug).toBe('acme');
      expect(tenant.tier).toBe('free');
      expect(tenant.status).toBe('provisioning');
      expect(tenant.config).toEqual({});
      expect(tenant.createdAt).toBeInstanceOf(Date);
      expect(tenant.updatedAt).toBeInstanceOf(Date);
    });

    it('creates a tenant with custom tier', async () => {
      const tenant = await registry.create({
        id: 'globex',
        name: 'Globex Corp',
        slug: 'globex',
        tier: 'enterprise',
      });

      expect(tenant.tier).toBe('enterprise');
    });

    it('creates a tenant with config', async () => {
      const tenant = await registry.create({
        id: 'initech',
        name: 'Initech',
        slug: 'initech',
        config: {
          rateLimitOverrides: { requestsPerSecond: 100 },
        },
      });

      expect(tenant.config.rateLimitOverrides?.requestsPerSecond).toBe(100);
    });

    it('rejects duplicate tenant ID', async () => {
      await registry.create({ id: 'dup', name: 'First', slug: 'first' });
      await expect(
        registry.create({ id: 'dup', name: 'Second', slug: 'second' }),
      ).rejects.toThrow('already exists');
    });

    it('rejects duplicate slug', async () => {
      await registry.create({ id: 'first', name: 'First', slug: 'same-slug' });
      await expect(
        registry.create({ id: 'second', name: 'Second', slug: 'same-slug' }),
      ).rejects.toThrow('slug');
    });

    it('creates many tenants', async () => {
      for (let i = 0; i < 50; i++) {
        await registry.create({ id: `t-${i}`, name: `Tenant ${i}`, slug: `slug-${i}` });
      }
      const list = await registry.list();
      expect(list).toHaveLength(50);
    });

    it('concurrent creates with unique ids succeed', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        registry.create({ id: `concurrent-${i}`, name: `T${i}`, slug: `s-${i}` }),
      );
      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
    });
  });

  describe('get', () => {
    it('returns a tenant by ID', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      const tenant = await registry.get('acme');
      expect(tenant).not.toBeNull();
      expect(tenant!.id).toBe('acme');
    });

    it('returns null for non-existent tenant', async () => {
      const tenant = await registry.get('nonexistent');
      expect(tenant).toBeNull();
    });

    it('returns the correct tenant among many', async () => {
      for (let i = 0; i < 10; i++) {
        await registry.create({ id: `t-${i}`, name: `Tenant ${i}`, slug: `slug-${i}` });
      }
      const tenant = await registry.get('t-5');
      expect(tenant!.name).toBe('Tenant 5');
    });
  });

  describe('getBySlug', () => {
    it('returns a tenant by slug', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme-corp' });
      const tenant = await registry.getBySlug('acme-corp');
      expect(tenant).not.toBeNull();
      expect(tenant!.id).toBe('acme');
    });

    it('returns null for non-existent slug', async () => {
      const tenant = await registry.getBySlug('nope');
      expect(tenant).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty array when no tenants', async () => {
      const tenants = await registry.list();
      expect(tenants).toEqual([]);
    });

    it('returns all tenants', async () => {
      await registry.create({ id: 'a', name: 'A', slug: 'a' });
      await registry.create({ id: 'b', name: 'B', slug: 'b' });
      await registry.create({ id: 'c', name: 'C', slug: 'c' });

      const tenants = await registry.list();
      expect(tenants).toHaveLength(3);
      expect(tenants.map((t) => t.id)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    });

    it('returns many tenants', async () => {
      for (let i = 0; i < 100; i++) {
        await registry.create({ id: `t-${i}`, name: `T${i}`, slug: `s-${i}` });
      }
      const tenants = await registry.list();
      expect(tenants).toHaveLength(100);
    });
  });

  describe('update', () => {
    it('updates tenant name', async () => {
      await registry.create({ id: 'acme', name: 'Old Name', slug: 'acme' });
      const updated = await registry.update('acme', { name: 'New Name' });
      expect(updated.name).toBe('New Name');
      expect(updated.slug).toBe('acme'); // unchanged
    });

    it('updates tenant tier', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      const updated = await registry.update('acme', { tier: 'enterprise' });
      expect(updated.tier).toBe('enterprise');
    });

    it('updates tenant status', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      const updated = await registry.update('acme', { status: 'active' });
      expect(updated.status).toBe('active');
    });

    it('updates tenant config', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      const updated = await registry.update('acme', {
        config: { rateLimitOverrides: { requestsPerSecond: 500 } },
      });
      expect(updated.config.rateLimitOverrides?.requestsPerSecond).toBe(500);
    });

    it('updates updatedAt timestamp', async () => {
      const original = await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      await new Promise((r) => setTimeout(r, 5));
      const updated = await registry.update('acme', { name: 'Updated' });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
    });

    it('throws TenantNotFoundError for non-existent tenant', async () => {
      await expect(
        registry.update('ghost', { name: 'Nope' }),
      ).rejects.toThrow(TenantNotFoundError);
    });

    it('error has correct properties', async () => {
      try {
        await registry.update('ghost', { name: 'Nope' });
      } catch (err) {
        expect(err).toBeInstanceOf(TenantNotFoundError);
        expect((err as TenantNotFoundError).tenantId).toBe('ghost');
        expect((err as TenantNotFoundError).code).toBe('TENANT_NOT_FOUND');
      }
    });

    it('rejects duplicate slug on update', async () => {
      await registry.create({ id: 'a', name: 'A', slug: 'slug-a' });
      await registry.create({ id: 'b', name: 'B', slug: 'slug-b' });

      await expect(
        registry.update('b', { slug: 'slug-a' }),
      ).rejects.toThrow('slug');
    });

    it('allows updating slug to the same value', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      // Same slug should not throw
      const updated = await registry.update('acme', { slug: 'acme' });
      expect(updated.slug).toBe('acme');
    });

    it('updates multiple fields at once', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      const updated = await registry.update('acme', {
        name: 'Acme Inc',
        tier: 'enterprise',
        status: 'active',
      });
      expect(updated.name).toBe('Acme Inc');
      expect(updated.tier).toBe('enterprise');
      expect(updated.status).toBe('active');
    });
  });

  describe('delete', () => {
    it('removes a tenant', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      await registry.delete('acme');
      const tenant = await registry.get('acme');
      expect(tenant).toBeNull();
    });

    it('throws TenantNotFoundError for non-existent tenant', async () => {
      await expect(registry.delete('ghost')).rejects.toThrow(TenantNotFoundError);
    });

    it('allows re-creating after delete', async () => {
      await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
      await registry.delete('acme');
      const recreated = await registry.create({ id: 'acme', name: 'Acme 2', slug: 'acme' });
      expect(recreated.name).toBe('Acme 2');
    });

    it('does not affect other tenants', async () => {
      await registry.create({ id: 'a', name: 'A', slug: 'a' });
      await registry.create({ id: 'b', name: 'B', slug: 'b' });
      await registry.delete('a');
      const remaining = await registry.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe('b');
    });
  });
});
