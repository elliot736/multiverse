import type { IncomingMessage, ServerResponse } from "node:http";
import { TenantContext } from "../tenant/context.js";
import type { Middleware } from "../http/types.js";
import type { TenantRateLimiter } from "./limiter.js";

/**
 * Configuration for the rate limit middleware.
 */
export interface RateLimitMiddlewareConfig {
  /** The tenant rate limiter instance */
  limiter: TenantRateLimiter;
  /** Number of tokens each request consumes. Default: 1 */
  tokensPerRequest?: number;
  /**
   * Custom key generator for more granular rate limiting.
   * For example, you could rate limit per endpoint.
   */
  keyGenerator?: (req: IncomingMessage) => string | undefined;
  /**
   * Custom handler for rate-limited requests.
   * If not provided, returns a standard 429 response.
   */
  onRateLimited?: (
    req: IncomingMessage,
    res: ServerResponse,
    retryAfterMs: number,
  ) => void;
}

/**
 * Rate limiting middleware that automatically scopes limits per tenant.
 *
 * Reads the tenant from AsyncLocalStorage (set by tenant resolution middleware)
 * and enforces the configured rate limit. Sets standard rate limit headers
 * on the response.
 */
export function rateLimitMiddleware(
  config: RateLimitMiddlewareConfig,
): Middleware {
  const tokensPerRequest = config.tokensPerRequest ?? 1;

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>,
  ): Promise<void> => {
    const tenant = TenantContext.currentOrNull();
    if (!tenant) {
      // No tenant context  skip rate limiting (might be a health check or public endpoint)
      return next();
    }

    const result = await config.limiter.consumeForTenant(
      tenant,
      tokensPerRequest,
    );

    // Set rate limit headers regardless of outcome
    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);

    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil((result.retryAfterMs ?? 1000) / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);
      res.setHeader("X-RateLimit-Reset", retryAfterSeconds);

      if (config.onRateLimited) {
        config.onRateLimited(req, res, result.retryAfterMs ?? 1000);
        return;
      }

      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Rate limit exceeded",
          retryAfterMs: result.retryAfterMs,
          retryAfterSeconds,
        }),
      );
      return;
    }

    return next();
  };
}
