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
