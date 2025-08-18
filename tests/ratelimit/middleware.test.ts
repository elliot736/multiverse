import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rateLimitMiddleware } from '../../src/ratelimit/middleware.js';
import { TenantRateLimiter } from '../../src/ratelimit/limiter.js';
import { TenantContext } from '../../src/tenant/context.js';
import type { Tenant } from '../../src/tenant/context.js';

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

function mockReq(): IncomingMessage {
  return { headers: {} } as unknown as IncomingMessage;
}

function mockRes() {
  const headers: Record<string, string | number> = {};
  let statusCode = 200;
  let body = '';
  return {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    end: vi.fn((data?: string) => { body = data ?? ''; }),
    setHeader: vi.fn((key: string, value: string | number) => { headers[key] = value; }),
    _status: () => statusCode,
    _body: () => body,
    _headers: () => headers,
  } as unknown as ServerResponse & {
    _status: () => number;
    _body: () => string;
    _headers: () => Record<string, string | number>;
  };
}

describe('rateLimitMiddleware', () => {
  let limiter: TenantRateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it('allows requests within limit and sets headers', async () => {
    limiter = new TenantRateLimiter({
      strategy: { type: 'token-bucket', capacity: 10, refillRate: 1 },
    });
    const mw = rateLimitMiddleware({ limiter });

    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;

    const tenant = makeTenant('acme');
    await TenantContext.run(tenant, () =>
      mw(req, res as unknown as ServerResponse, async () => {
        nextCalled = true;
      }),
    );

    expect(nextCalled).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
  });

  it('returns 429 when rate limited', async () => {
    limiter = new TenantRateLimiter({
      strategy: { type: 'token-bucket', capacity: 1, refillRate: 0.001 },
    });
    const mw = rateLimitMiddleware({ limiter });

    const tenant = makeTenant('acme');

    // First request passes
    await TenantContext.run(tenant, () =>
      mw(mockReq(), mockRes() as unknown as ServerResponse, async () => {}),
    );

    // Second request is rate limited
    const res = mockRes();
    let nextCalled = false;
    await TenantContext.run(tenant, () =>
      mw(mockReq(), res as unknown as ServerResponse, async () => {
        nextCalled = true;
      }),
    );

    expect(nextCalled).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  it('skips rate limiting when no tenant context', async () => {
    limiter = new TenantRateLimiter({
      strategy: { type: 'token-bucket', capacity: 1, refillRate: 1 },
    });
    const mw = rateLimitMiddleware({ limiter });

    const res = mockRes();
    let nextCalled = false;

    // No TenantContext.run -- should skip rate limiting
    await mw(mockReq(), res as unknown as ServerResponse, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it('uses custom onRateLimited handler', async () => {
    limiter = new TenantRateLimiter({
      strategy: { type: 'token-bucket', capacity: 1, refillRate: 0.001 },
    });

    let customHandlerCalled = false;
    const mw = rateLimitMiddleware({
      limiter,
      onRateLimited: (_req, _res, retryAfterMs) => {
        customHandlerCalled = true;
        expect(retryAfterMs).toBeGreaterThan(0);
      },
    });

    const tenant = makeTenant('acme');

    await TenantContext.run(tenant, () =>
      mw(mockReq(), mockRes() as unknown as ServerResponse, async () => {}),
    );

    await TenantContext.run(tenant, () =>
      mw(mockReq(), mockRes() as unknown as ServerResponse, async () => {}),
    );

    expect(customHandlerCalled).toBe(true);
  });
});
