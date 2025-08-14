/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining tokens/requests */
  remaining: number;
  /** Milliseconds until the request can be retried (only set when not allowed) */
  retryAfterMs?: number;
  /** Total limit for the window/bucket */
  limit: number;
}

/**
 * Interface for rate limiting strategies.
 */
export interface RateLimiter {
  /**
   * Attempt to consume tokens for the given key.
   * @param key - The rate limit key (typically tenant ID or tenant:endpoint)
   * @param tokens - Number of tokens to consume (default: 1)
   */
  consume(key: string, tokens?: number): Promise<RateLimitResult>;

  /**
   * Reset the rate limit state for a key.
   */
  reset(key: string): Promise<void>;
}

/**
 * Token bucket configuration.
 */
export interface TokenBucketConfig {
  /** Maximum number of tokens (burst capacity) */
  capacity: number;
  /** Tokens added per second */
  refillRate: number;
}

/**
 * Token bucket rate limiter.
 *
 * Allows controlled bursts up to the bucket capacity while maintaining
 * a sustained average rate. Tokens are refilled at a constant rate.
 *
 * Example: capacity=10, refillRate=2 means a burst of 10 requests is allowed,
 * then 2 requests per second sustained. The bucket refills continuously.
 */
export class TokenBucketLimiter implements RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly config: TokenBucketConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TokenBucketConfig) {
    if (config.capacity <= 0)
      throw new Error("Token bucket capacity must be positive");
    if (config.refillRate <= 0)
      throw new Error("Token bucket refill rate must be positive");
    this.config = config;

    // Periodically clean up stale buckets to prevent memory leaks
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 60_000);
    // Allow the timer to not prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  async consume(key: string, tokens: number = 1): Promise<RateLimitResult> {
    const bucket = this.getOrCreateBucket(key);
    return bucket.consume(tokens);
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /**
   * Stop the cleanup timer. Call this when shutting down.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private getOrCreateBucket(key: string): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.config.capacity, this.config.refillRate);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private cleanupStale(): void {
    const now = Date.now();
    // Remove buckets that haven't been accessed in 2x the time to fully refill
    const maxIdleMs =
      (this.config.capacity / this.config.refillRate) * 1000 * 2;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastAccess > maxIdleMs) {
        this.buckets.delete(key);
      }
    }
  }
}

class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second
  private lastRefill: number;
  public lastAccess: number;

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity; // Start full
    this.lastRefill = Date.now();
    this.lastAccess = Date.now();
  }

  consume(requested: number): RateLimitResult {
    this.refill();
    this.lastAccess = Date.now();

    if (this.tokens >= requested) {
      this.tokens -= requested;
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        limit: this.capacity,
      };
    }

    // Not enough tokens  calculate when they'll be available
    const deficit = requested - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillRate) * 1000);

    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      retryAfterMs,
      limit: this.capacity,
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

/**
 * Sliding window configuration.
 */
export interface SlidingWindowConfig {
  /** Window duration in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per window */
  maxRequests: number;
}

/**
 * Sliding window rate limiter.
 *
 * Tracks requests across two fixed windows and weights them by the overlap
 * with the current sliding window. This provides a smooth approximation
 * of a true sliding window without storing individual request timestamps.
 *
 * Example: windowMs=60000 (1 min), maxRequests=100 means 100 requests per
 * rolling minute. The count smoothly transitions between windows.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private windows = new Map<string, SlidingWindowState>();
  private readonly config: SlidingWindowConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SlidingWindowConfig) {
    if (config.windowMs <= 0)
      throw new Error("Sliding window duration must be positive");
    if (config.maxRequests <= 0)
      throw new Error("Sliding window max requests must be positive");
    this.config = config;

    this.cleanupTimer = setInterval(() => this.cleanupStale(), 60_000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  async consume(key: string, tokens: number = 1): Promise<RateLimitResult> {
    const state = this.getOrCreateState(key);
    const now = Date.now();
    const windowStart = this.getWindowStart(now);

    // Advance windows if needed
    if (windowStart !== state.currentWindowStart) {
      if (windowStart - state.currentWindowStart >= this.config.windowMs * 2) {
        // Both windows are stale
        state.previousCount = 0;
        state.currentCount = 0;
      } else {
        // Shift windows
        state.previousCount = state.currentCount;
        state.currentCount = 0;
      }
      state.currentWindowStart = windowStart;
    }

    // Calculate weighted count using sliding window approximation
    const elapsed = now - windowStart;
    const weight = 1 - elapsed / this.config.windowMs;
    const approximateCount =
      state.currentCount + Math.floor(state.previousCount * weight);

    if (approximateCount + tokens > this.config.maxRequests) {
      // Calculate retry-after: time until enough requests expire from the previous window
      const remaining = this.config.maxRequests - approximateCount;
      const retryAfterMs =
        remaining < 0
          ? Math.ceil(this.config.windowMs - elapsed)
          : Math.ceil(
              (this.config.windowMs - elapsed) *
                ((tokens - remaining) / (state.previousCount * weight || 1)),
            );

      return {
        allowed: false,
        remaining: Math.max(0, this.config.maxRequests - approximateCount),
        retryAfterMs: Math.max(1, Math.min(retryAfterMs, this.config.windowMs)),
        limit: this.config.maxRequests,
      };
    }

    state.currentCount += tokens;

    return {
      allowed: true,
      remaining: Math.max(
        0,
        this.config.maxRequests - approximateCount - tokens,
      ),
      limit: this.config.maxRequests,
    };
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private getOrCreateState(key: string): SlidingWindowState {
    let state = this.windows.get(key);
    if (!state) {
      state = {
        currentWindowStart: this.getWindowStart(Date.now()),
        currentCount: 0,
        previousCount: 0,
      };
      this.windows.set(key, state);
    }
    return state;
  }

  private getWindowStart(now: number): number {
    return Math.floor(now / this.config.windowMs) * this.config.windowMs;
  }

  private cleanupStale(): void {
    const now = Date.now();
    const staleThreshold = now - this.config.windowMs * 3;
    for (const [key, state] of this.windows) {
      if (state.currentWindowStart < staleThreshold) {
        this.windows.delete(key);
      }
    }
  }
}

interface SlidingWindowState {
  currentWindowStart: number;
  currentCount: number;
  previousCount: number;
}
