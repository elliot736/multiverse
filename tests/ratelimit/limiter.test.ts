import { describe, it, expect, afterEach } from 'vitest';
import { TenantRateLimiter } from '../../src/ratelimit/limiter.js';
import { TenantContext } from '../../src/tenant/context.js';
import type { Tenant } from '../../src/tenant/context.js';
import { NoTenantContextError } from '../../src/errors.js';

function makeTenant(id: string, tier: Tenant['tier'] = 'professional'): Tenant {
  return {
    id,
    name: `Tenant ${id}`,
    slug: id,
    tier,
    status: 'active',
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('TenantRateLimiter', () => {
  let limiter: TenantRateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  describe('with token bucket strategy', () => {
    it('rate limits per tenant using context', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 3, refillRate: 1 },
      });

      const tenant = makeTenant('acme');

      await TenantContext.run(tenant, async () => {
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(false);
      });
    });

    it('isolates limits between tenants', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 2, refillRate: 1 },
      });

      const tenantA = makeTenant('a');
      const tenantB = makeTenant('b');

      await TenantContext.run(tenantA, async () => {
        await limiter.consume();
        await limiter.consume();
        expect((await limiter.consume()).allowed).toBe(false);
      });

      await TenantContext.run(tenantB, async () => {
        expect((await limiter.consume()).allowed).toBe(true);
      });
    });

    it('throws when no tenant context', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 10, refillRate: 1 },
      });

      await expect(limiter.consume()).rejects.toThrow(NoTenantContextError);
    });

    it('returns remaining count', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 5, refillRate: 1 },
      });

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, async () => {
        const result = await limiter.consume();
        expect(result.remaining).toBe(4);
        expect(result.limit).toBe(5);
      });
    });
  });

  describe('tier overrides', () => {
    it('applies higher limits for enterprise tier', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 2, refillRate: 1 },
        tierOverrides: {
          enterprise: { capacity: 10, refillRate: 5 },
        },
      });

      const freeTenant = makeTenant('free-co', 'free');
      const enterpriseTenant = makeTenant('big-co', 'enterprise');

      await TenantContext.run(freeTenant, async () => {
        await limiter.consume();
        await limiter.consume();
        expect((await limiter.consume()).allowed).toBe(false);
      });

      await TenantContext.run(enterpriseTenant, async () => {
        for (let i = 0; i < 10; i++) {
          expect((await limiter.consume()).allowed).toBe(true);
        }
        expect((await limiter.consume()).allowed).toBe(false);
      });
    });

    it('uses default limiter for tiers without overrides', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 3, refillRate: 1 },
        tierOverrides: {
          enterprise: { capacity: 100, refillRate: 50 },
        },
      });

      const starterTenant = makeTenant('starter-co', 'starter');
      await TenantContext.run(starterTenant, async () => {
        await limiter.consume();
        await limiter.consume();
        await limiter.consume();
        expect((await limiter.consume()).allowed).toBe(false);
      });
    });
  });

  describe('with sliding window strategy', () => {
    it('rate limits per tenant', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'sliding-window', windowMs: 60_000, maxRequests: 3 },
      });

      const tenant = makeTenant('acme');

      await TenantContext.run(tenant, async () => {
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(false);
      });
    });
  });

  describe('consumeForTenant (explicit)', () => {
    it('does not require tenant context', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 5, refillRate: 1 },
      });

      const tenant = makeTenant('explicit');
      const result = await limiter.consumeForTenant(tenant);
      expect(result.allowed).toBe(true);
    });

    it('respects tenant tier', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 2, refillRate: 1 },
        tierOverrides: {
          enterprise: { capacity: 100, refillRate: 50 },
        },
      });

      const freeTenant = makeTenant('free', 'free');
      const entTenant = makeTenant('ent', 'enterprise');

      await limiter.consumeForTenant(freeTenant);
      await limiter.consumeForTenant(freeTenant);
      const freeResult = await limiter.consumeForTenant(freeTenant);
      expect(freeResult.allowed).toBe(false);

      const entResult = await limiter.consumeForTenant(entTenant);
      expect(entResult.allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('resets the rate limit for the current tenant', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 1, refillRate: 0.001 },
      });

      const tenant = makeTenant('acme');

      await TenantContext.run(tenant, async () => {
        await limiter.consume();
        expect((await limiter.consume()).allowed).toBe(false);

        await limiter.reset();

        expect((await limiter.consume()).allowed).toBe(true);
      });
    });
  });

  describe('tenant config rate limit overrides', () => {
    it('uses tenant-specific overrides from config', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 2, refillRate: 1 },
      });

      const tenant: Tenant = {
        ...makeTenant('custom'),
        config: {
          rateLimitOverrides: {
            burstCapacity: 5,
            requestsPerSecond: 2,
          },
        },
      };

      await TenantContext.run(tenant, async () => {
        for (let i = 0; i < 5; i++) {
          const result = await limiter.consumeForTenant(tenant);
          expect(result.allowed).toBe(true);
        }
      });
    });
  });

  describe('keySuffix', () => {
    it('uses keySuffix for more granular rate limiting', async () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 1, refillRate: 0.001 },
        keySuffix: (tenant) => tenant.tier,
      });

      const tenant = makeTenant('acme');
      await TenantContext.run(tenant, async () => {
        // First consume uses key "acme:professional"
        expect((await limiter.consume()).allowed).toBe(true);
        expect((await limiter.consume()).allowed).toBe(false);
      });
    });
  });

  describe('destroy', () => {
    it('cleans up all limiter timers', () => {
      limiter = new TenantRateLimiter({
        strategy: { type: 'token-bucket', capacity: 10, refillRate: 1 },
        tierOverrides: {
          enterprise: { capacity: 100, refillRate: 50 },
          starter: { capacity: 20, refillRate: 5 },
        },
      });

      // Should not throw
      limiter.destroy();
    });
  });
});
