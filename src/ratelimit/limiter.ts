import { TenantContext } from '../tenant/context.js';
import type { Tenant } from '../tenant/context.js';
import type { RateLimiter, RateLimitResult, TokenBucketConfig, SlidingWindowConfig } from './strategies.js';
import { TokenBucketLimiter, SlidingWindowLimiter } from './strategies.js';

/**
 * Configuration for the per-tenant rate limiter.
 */
export interface TenantRateLimiterConfig {
  /** Rate limit strategy and config */
  strategy: TokenBucketStrategyConfig | SlidingWindowStrategyConfig;
  /** Per-tier overrides. Key is the tier name, value overrides the default config. */
  tierOverrides?: Record<string, Partial<TokenBucketConfig | SlidingWindowConfig>>;
  /** Optional key suffix generator for more granular rate limiting (e.g., per-endpoint) */
  keySuffix?: (tenant: Tenant) => string;
}

interface TokenBucketStrategyConfig extends TokenBucketConfig {
  type: 'token-bucket';
}

interface SlidingWindowStrategyConfig extends SlidingWindowConfig {
  type: 'sliding-window';
}

/**
 * Per-tenant rate limiter that automatically scopes limits by tenant
 * using the TenantContext from AsyncLocalStorage.
 *
 * Supports per-tier overrides so that enterprise tenants can have higher limits
 * than free-tier tenants.
 */
export class TenantRateLimiter {
  private readonly defaultLimiter: RateLimiter;
  private readonly tierLimiters = new Map<string, RateLimiter>();
  private readonly config: TenantRateLimiterConfig;

  constructor(config: TenantRateLimiterConfig) {
    this.config = config;
    this.defaultLimiter = this.createLimiter(config.strategy);

    // Create per-tier limiters with overrides
    if (config.tierOverrides) {
      for (const [tier, overrides] of Object.entries(config.tierOverrides)) {
        const mergedConfig = { ...config.strategy, ...overrides };
        this.tierLimiters.set(tier, this.createLimiter(mergedConfig as TokenBucketStrategyConfig | SlidingWindowStrategyConfig));
      }
    }
  }

  /**
   * Check rate limit for the current tenant (from AsyncLocalStorage context).
   */
  async consume(tokens: number = 1): Promise<RateLimitResult> {
    const tenant = TenantContext.current();
    return this.consumeForTenant(tenant, tokens);
  }

  /**
   * Check rate limit for an explicit tenant.
   */
  async consumeForTenant(tenant: Tenant, tokens: number = 1): Promise<RateLimitResult> {
    // Check for tenant-specific rate limit overrides
    if (tenant.config.rateLimitOverrides) {
      const overrides = tenant.config.rateLimitOverrides;
      if (this.config.strategy.type === 'token-bucket') {
        const customConfig: TokenBucketStrategyConfig = {
          type: 'token-bucket',
          capacity: overrides.burstCapacity ?? (this.config.strategy as TokenBucketConfig).capacity,
          refillRate: overrides.requestsPerSecond ?? (this.config.strategy as TokenBucketConfig).refillRate,
        };
        const customLimiter = this.createLimiter(customConfig);
        const key = this.buildKey(tenant);
        return customLimiter.consume(key, tokens);
      }
    }

    // Use tier-specific limiter if available
    const limiter = this.tierLimiters.get(tenant.tier) ?? this.defaultLimiter;
    const key = this.buildKey(tenant);
    return limiter.consume(key, tokens);
  }

  /**
   * Reset rate limit state for the current tenant.
   */
  async reset(): Promise<void> {
    const tenant = TenantContext.current();
    const key = this.buildKey(tenant);
    const limiter = this.tierLimiters.get(tenant.tier) ?? this.defaultLimiter;
    await limiter.reset(key);
  }

  /**
   * Destroy all limiters and clean up timers.
   */
  destroy(): void {
    this.destroyLimiter(this.defaultLimiter);
    for (const limiter of this.tierLimiters.values()) {
      this.destroyLimiter(limiter);
    }
  }

  private buildKey(tenant: Tenant): string {
    const suffix = this.config.keySuffix?.(tenant) ?? '';
    return suffix ? `${tenant.id}:${suffix}` : tenant.id;
  }

  private createLimiter(config: TokenBucketStrategyConfig | SlidingWindowStrategyConfig): RateLimiter {
    switch (config.type) {
      case 'token-bucket':
        return new TokenBucketLimiter({
          capacity: config.capacity,
          refillRate: config.refillRate,
        });
      case 'sliding-window':
        return new SlidingWindowLimiter({
          windowMs: config.windowMs,
          maxRequests: config.maxRequests,
        });
    }
  }

  private destroyLimiter(limiter: RateLimiter): void {
    if (limiter instanceof TokenBucketLimiter) {
      limiter.destroy();
    } else if (limiter instanceof SlidingWindowLimiter) {
      limiter.destroy();
    }
  }
}
