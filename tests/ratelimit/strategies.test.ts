import { describe, it, expect, afterEach } from 'vitest';
import { TokenBucketLimiter, SlidingWindowLimiter } from '../../src/ratelimit/strategies.js';

describe('TokenBucketLimiter', () => {
  let limiter: TokenBucketLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it('allows requests up to capacity', async () => {
    limiter = new TokenBucketLimiter({ capacity: 5, refillRate: 1 });

    for (let i = 0; i < 5; i++) {
      const result = await limiter.consume('tenant-a');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
  });

  it('rejects when bucket is empty', async () => {
    limiter = new TokenBucketLimiter({ capacity: 3, refillRate: 1 });

    for (let i = 0; i < 3; i++) {
      await limiter.consume('tenant-a');
    }

    const result = await limiter.consume('tenant-a');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills tokens over time', async () => {
    limiter = new TokenBucketLimiter({ capacity: 5, refillRate: 100 });

    for (let i = 0; i < 5; i++) {
      await limiter.consume('tenant-a');
    }

    await new Promise((resolve) => setTimeout(resolve, 60));

    const result = await limiter.consume('tenant-a');
    expect(result.allowed).toBe(true);
  });

  it('isolates keys (per-tenant)', async () => {
    limiter = new TokenBucketLimiter({ capacity: 2, refillRate: 1 });

    await limiter.consume('tenant-a');
    await limiter.consume('tenant-a');
    const aResult = await limiter.consume('tenant-a');
    expect(aResult.allowed).toBe(false);

    const bResult = await limiter.consume('tenant-b');
    expect(bResult.allowed).toBe(true);
    expect(bResult.remaining).toBe(1);
  });

  it('supports consuming multiple tokens', async () => {
    limiter = new TokenBucketLimiter({ capacity: 10, refillRate: 1 });

    const result = await limiter.consume('tenant-a', 7);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);

    const result2 = await limiter.consume('tenant-a', 5);
    expect(result2.allowed).toBe(false);
  });

  it('reports correct limit', async () => {
    limiter = new TokenBucketLimiter({ capacity: 50, refillRate: 10 });
    const result = await limiter.consume('tenant-a');
    expect(result.limit).toBe(50);
  });

  it('does not exceed capacity on refill', async () => {
    limiter = new TokenBucketLimiter({ capacity: 5, refillRate: 1000 });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await limiter.consume('tenant-a');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(5);
  });

  it('calculates retryAfterMs based on deficit', async () => {
    limiter = new TokenBucketLimiter({ capacity: 1, refillRate: 2 });

    await limiter.consume('tenant-a');

    const result = await limiter.consume('tenant-a');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(400);
    expect(result.retryAfterMs).toBeLessThanOrEqual(600);
  });

  it('resets a key', async () => {
    limiter = new TokenBucketLimiter({ capacity: 2, refillRate: 1 });

    await limiter.consume('tenant-a');
    await limiter.consume('tenant-a');
    expect((await limiter.consume('tenant-a')).allowed).toBe(false);

    await limiter.reset('tenant-a');

    const result = await limiter.consume('tenant-a');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('throws on invalid config', () => {
    expect(() => new TokenBucketLimiter({ capacity: 0, refillRate: 1 })).toThrow();
    expect(() => new TokenBucketLimiter({ capacity: 1, refillRate: -1 })).toThrow();
    expect(() => new TokenBucketLimiter({ capacity: -1, refillRate: 1 })).toThrow();
    expect(() => new TokenBucketLimiter({ capacity: 1, refillRate: 0 })).toThrow();
  });

  it('handles concurrent consume calls', async () => {
    limiter = new TokenBucketLimiter({ capacity: 5, refillRate: 0.001 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume('tenant-a')),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(5);
    expect(denied).toBe(5);
  });
