import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TenantContext } from '../src/tenant/context.js';
import type { Tenant } from '../src/tenant/context.js';
import { MemoryTenantRegistry } from '../src/tenant/registry.js';
import { HeaderTenantResolver, ChainTenantResolver, PathTenantResolver } from '../src/tenant/resolver.js';
import { InMemoryEventBus } from '../src/events/bus.js';
import { TenantRateLimiter } from '../src/ratelimit/limiter.js';
import { createMultiverseMiddleware, composeMiddleware } from '../src/http/middleware.js';
import type { DomainEvent } from '../src/events/types.js';
import {
  MultiverseError,
  TenantNotFoundError,
  CrossTenantAccessError,
  NoTenantContextError,
  RateLimitExceededError,
  OutboxPublishError,
  AuthenticationError,
  TenantResolutionError,
  MigrationError,
} from '../src/errors.js';

// --- Helpers ---

function mockReq(overrides: {
  headers?: Record<string, string>;
  url?: string;
} = {}): IncomingMessage {
  return {
    headers: overrides.headers ?? {},
    url: overrides.url ?? '/',
  } as unknown as IncomingMessage;
}

function mockRes() {
  let statusCode = 200;
  let body = '';
  const headers: Record<string, string | number> = {};
  return {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    end: vi.fn((data?: string) => { body = data ?? ''; }),
    setHeader: vi.fn((key: string, value: string | number) => { headers[key] = value; }),
    getHeader: vi.fn((key: string) => headers[key]),
    _status: () => statusCode,
    _body: () => body,
    _headers: () => headers,
  } as unknown as ServerResponse & {
    _status: () => number;
    _body: () => string;
    _headers: () => Record<string, string | number>;
  };
}

// --- Tests ---

describe('Integration: Full request flow', () => {
  let registry: MemoryTenantRegistry;
  let rateLimiter: TenantRateLimiter;

  beforeEach(async () => {
    registry = new MemoryTenantRegistry();
    await registry.create({
      id: 'acme',
      name: 'Acme Corp',
      slug: 'acme',
      tier: 'professional',
    });
    await registry.update('acme', { status: 'active' });

    await registry.create({
      id: 'globex',
      name: 'Globex Corp',
      slug: 'globex',
      tier: 'enterprise',
    });
    await registry.update('globex', { status: 'active' });

    rateLimiter = new TenantRateLimiter({
      strategy: { type: 'token-bucket', capacity: 5, refillRate: 1 },
      tierOverrides: {
        enterprise: { capacity: 100, refillRate: 50 },
      },
    });
  });

  afterEach(() => {
    rateLimiter.destroy();
  });

  it('resolves tenant, applies rate limit, and reaches handler', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      auth: { skipAuth: true },
      rateLimiter,
      publicPaths: ['/health'],
    });

    const req = mockReq({ headers: { 'x-tenant-id': 'acme' }, url: '/api/orders' });
    const res = mockRes();
    let handlerCalled = false;
    let handlerTenantId: string | null = null;

    await middleware(req, res as unknown as ServerResponse, async () => {
      handlerCalled = true;
      handlerTenantId = TenantContext.current().id;
    });

    expect(handlerCalled).toBe(true);
    expect(handlerTenantId).toBe('acme');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 5);
  });

  it('returns 400 when tenant cannot be resolved', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
    });

    const req = mockReq({ url: '/api/orders' });
    const res = mockRes();

    await middleware(req, res as unknown as ServerResponse, async () => {});

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res._body()).toContain('Unable to determine tenant');
  });

  it('returns 404 for unknown tenant', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
    });

    const req = mockReq({ headers: { 'x-tenant-id': 'ghost' } });
    const res = mockRes();

    await middleware(req, res as unknown as ServerResponse, async () => {});

    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('returns 403 for suspended tenant', async () => {
    await registry.update('acme', { status: 'suspended' });

    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
    });

    const req = mockReq({ headers: { 'x-tenant-id': 'acme' } });
    const res = mockRes();

    await middleware(req, res as unknown as ServerResponse, async () => {});

    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(res._body()).toContain('suspended');
  });

  it('allows provisioning status tenants through', async () => {
    // Provisioning tenants are not suspended, so they should pass through
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      auth: { skipAuth: true },
    });

    // Create a new tenant in provisioning status
    await registry.create({ id: 'newco', name: 'New Co', slug: 'newco' });

    const req = mockReq({ headers: { 'x-tenant-id': 'newco' } });
    const res = mockRes();
    let handlerCalled = false;

    await middleware(req, res as unknown as ServerResponse, async () => {
      handlerCalled = true;
    });

    expect(handlerCalled).toBe(true);
  });

  it('skips middleware for public paths', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      publicPaths: ['/health', '/api/public/*'],
    });

    const req = mockReq({ url: '/health' });
    const res = mockRes();
    let reached = false;

    await middleware(req, res as unknown as ServerResponse, async () => {
      reached = true;
    });

    expect(reached).toBe(true);
  });

  it('skips middleware for public path prefix', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      publicPaths: ['/api/public/*'],
    });

    const req = mockReq({ url: '/api/public/docs' });
    const res = mockRes();
    let reached = false;

    await middleware(req, res as unknown as ServerResponse, async () => {
      reached = true;
    });

    expect(reached).toBe(true);
  });

  it('returns 429 when rate limited', async () => {
    const tightLimiter = new TenantRateLimiter({
      strategy: { type: 'token-bucket', capacity: 1, refillRate: 0.001 },
    });

    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      auth: { skipAuth: true },
      rateLimiter: tightLimiter,
    });

    const makeReq = () => mockReq({ headers: { 'x-tenant-id': 'acme' }, url: '/api/test' });

    const res1 = mockRes();
    let called1 = false;
    await middleware(makeReq(), res1 as unknown as ServerResponse, async () => { called1 = true; });
    expect(called1).toBe(true);

    const res2 = mockRes();
    let called2 = false;
    await middleware(makeReq(), res2 as unknown as ServerResponse, async () => { called2 = true; });
    expect(called2).toBe(false);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.any(Object));

    tightLimiter.destroy();
  });

  it('enterprise tenants have higher rate limits', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      auth: { skipAuth: true },
      rateLimiter,
    });

    // Send 5 requests for acme (professional tier, capacity 5)
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await middleware(
        mockReq({ headers: { 'x-tenant-id': 'acme' }, url: '/api/test' }),
        res as unknown as ServerResponse,
        async () => {},
      );
    }

    // 6th request for acme should be rate limited
    const res6 = mockRes();
    let acmeBlocked = false;
    await middleware(
      mockReq({ headers: { 'x-tenant-id': 'acme' }, url: '/api/test' }),
      res6 as unknown as ServerResponse,
      async () => { acmeBlocked = false; },
    );
    // If handler wasn't called and 429 was written
    if (res6.writeHead.mock.calls.some((c: unknown[]) => c[0] === 429)) {
      acmeBlocked = true;
    }
    expect(acmeBlocked).toBe(true);

    // Globex (enterprise, capacity 100) should still be fine
    const resGlobex = mockRes();
    let globexPassed = false;
    await middleware(
      mockReq({ headers: { 'x-tenant-id': 'globex' }, url: '/api/test' }),
      resGlobex as unknown as ServerResponse,
      async () => { globexPassed = true; },
    );
    expect(globexPassed).toBe(true);
  });

  it('works without auth and rate limiter', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
    });

    const req = mockReq({ headers: { 'x-tenant-id': 'acme' } });
    const res = mockRes();
    let handlerCalled = false;

    await middleware(req, res as unknown as ServerResponse, async () => {
      handlerCalled = true;
      expect(TenantContext.current().id).toBe('acme');
    });

    expect(handlerCalled).toBe(true);
  });

  it('handles concurrent requests for different tenants', async () => {
    const middleware = createMultiverseMiddleware({
      resolver: new HeaderTenantResolver(),
      registry,
      auth: { skipAuth: true },
    });

    const results = await Promise.all(
      ['acme', 'globex'].map(async (tenantId) => {
        const req = mockReq({ headers: { 'x-tenant-id': tenantId } });
        const res = mockRes();
        let observedId: string | null = null;

        await middleware(req, res as unknown as ServerResponse, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          observedId = TenantContext.current().id;
        });

        return observedId;
      }),
    );

    expect(results).toEqual(['acme', 'globex']);
  });
});

describe('Integration: Event Bus', () => {
  it('publishes and subscribes to events', async () => {
    const bus = new InMemoryEventBus();
    const received: DomainEvent[] = [];

    bus.subscribe('order.created', async (event) => {
      received.push(event);
    });

    bus.subscribe('order.shipped', async (event) => {
      received.push(event);
    });

    await bus.publish({
      id: '1',
      tenantId: 'acme',
      aggregateId: 'ord-1',
      aggregateType: 'order',
      eventType: 'order.created',
      payload: { total: 42 },
      idempotencyKey: 'k1',
      createdAt: new Date(),
    });

    await bus.publish({
      id: '2',
      tenantId: 'acme',
      aggregateId: 'ord-1',
      aggregateType: 'order',
      eventType: 'order.shipped',
      payload: { trackingNumber: 'TRK123' },
      idempotencyKey: 'k2',
      createdAt: new Date(),
    });

    expect(received).toHaveLength(2);
    expect(received[0]!.eventType).toBe('order.created');
    expect(received[1]!.eventType).toBe('order.shipped');
  });

  it('wildcard handler receives all events', async () => {
    const bus = new InMemoryEventBus();
    const all: string[] = [];

    bus.subscribe('*', async (event) => {
      all.push(event.eventType);
    });

    for (const type of ['a', 'b', 'c']) {
      await bus.publish({
        id: type,
        tenantId: 'acme',
        aggregateId: '1',
        aggregateType: 'test',
        eventType: type,
        payload: {},
        idempotencyKey: type,
        createdAt: new Date(),
      });
    }

    expect(all).toEqual(['a', 'b', 'c']);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];
    const handler = async (event: DomainEvent) => {
      received.push(event.eventType);
    };

    bus.subscribe('test', handler);

    const makeEvent = (id: string): DomainEvent => ({
      id,
      tenantId: 'acme',
      aggregateId: '1',
      aggregateType: 'test',
      eventType: 'test',
      payload: {},
      idempotencyKey: id,
      createdAt: new Date(),
    });

    await bus.publish(makeEvent('1'));
    bus.unsubscribe('test', handler);
    await bus.publish(makeEvent('2'));

    expect(received).toHaveLength(1);
  });

  it('error in handler does not break other handlers', async () => {
    const bus = new InMemoryEventBus();
    let secondHandlerCalled = false;

    bus.subscribe('test', async () => {
      throw new Error('fail');
    });
    bus.subscribe('test', async () => {
      secondHandlerCalled = true;
    });

    const event: DomainEvent = {
      id: '1',
      tenantId: 'acme',
      aggregateId: '1',
      aggregateType: 'test',
      eventType: 'test',
      payload: {},
      idempotencyKey: '1',
      createdAt: new Date(),
    };

    try { await bus.publish(event); } catch { /* expected */ }
    expect(secondHandlerCalled).toBe(true);
  });
});

describe('Integration: Tenant Context propagation', () => {
  it('propagates tenant through async call chain', async () => {
    const tenant: Tenant = {
      id: 'acme',
      name: 'Acme',
      slug: 'acme',
      tier: 'professional',
      status: 'active',
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    async function handleRequest() {
      const t = TenantContext.current();
      expect(t.id).toBe('acme');
      return await processOrder();
    }

    async function processOrder() {
      await new Promise((r) => setTimeout(r, 5));
      const t = TenantContext.current();
      expect(t.id).toBe('acme');
      return await saveOrder();
    }

    async function saveOrder() {
      const t = TenantContext.current();
      expect(t.id).toBe('acme');
      return 'saved';
    }

    const result = await TenantContext.run(tenant, handleRequest);
    expect(result).toBe('saved');
  });

  it('concurrent requests do not leak tenant context', async () => {
    const tenants = ['alpha', 'beta', 'gamma', 'delta'].map(id => ({
      id,
      name: id,
      slug: id,
      tier: 'free' as const,
      status: 'active' as const,
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const results = await Promise.all(
      tenants.map((tenant) =>
        TenantContext.run(tenant, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          return TenantContext.current().id;
        }),
      ),
    );

    expect(results).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  it('many concurrent requests maintain isolation', async () => {
    const count = 50;
    const tenants = Array.from({ length: count }, (_, i) => ({
      id: `tenant-${i}`,
      name: `T${i}`,
      slug: `t-${i}`,
      tier: 'free' as const,
      status: 'active' as const,
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const results = await Promise.all(
      tenants.map((tenant) =>
        TenantContext.run(tenant, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return TenantContext.current().id;
        }),
      ),
    );

    for (let i = 0; i < count; i++) {
      expect(results[i]).toBe(`tenant-${i}`);
    }
  });
});

describe('Integration: Chain Resolver with middleware', () => {
  it('falls back through resolver chain', async () => {
    const registry = new MemoryTenantRegistry();
    await registry.create({ id: 'pathco', name: 'Path Co', slug: 'pathco' });
    await registry.update('pathco', { status: 'active' });

    const middleware = createMultiverseMiddleware({
      resolver: new ChainTenantResolver([
        new HeaderTenantResolver(),
        new PathTenantResolver(),
      ]),
      registry,
      auth: { skipAuth: true },
    });

    const req = mockReq({ url: '/pathco/api/data' });
    const res = mockRes();
    let tenantId: string | null = null;

    await middleware(req, res as unknown as ServerResponse, async () => {
      tenantId = TenantContext.current().id;
    });

    expect(tenantId).toBe('pathco');
  });

  it('uses header when both header and path are available', async () => {
    const registry = new MemoryTenantRegistry();
    await registry.create({ id: 'acme', name: 'Acme', slug: 'acme' });
    await registry.update('acme', { status: 'active' });
    await registry.create({ id: 'globex', name: 'Globex', slug: 'globex' });
    await registry.update('globex', { status: 'active' });

    const middleware = createMultiverseMiddleware({
      resolver: new ChainTenantResolver([
        new HeaderTenantResolver(),
        new PathTenantResolver(),
      ]),
      registry,
      auth: { skipAuth: true },
    });

    // Header says 'acme', path says 'globex'
    const req = mockReq({ headers: { 'x-tenant-id': 'acme' }, url: '/globex/api' });
    const res = mockRes();
    let tenantId: string | null = null;

    await middleware(req, res as unknown as ServerResponse, async () => {
      tenantId = TenantContext.current().id;
    });

    expect(tenantId).toBe('acme'); // Header takes priority
  });
});

describe('Integration: composeMiddleware', () => {
  it('executes middleware in order', async () => {
    const order: string[] = [];

    const mw1 = async (_req: IncomingMessage, _res: ServerResponse, next: () => Promise<void>) => {
      order.push('mw1-before');
      await next();
      order.push('mw1-after');
    };

    const mw2 = async (_req: IncomingMessage, _res: ServerResponse, next: () => Promise<void>) => {
      order.push('mw2-before');
      await next();
      order.push('mw2-after');
    };

    const composed = composeMiddleware(mw1, mw2);
    const req = mockReq();
    const res = mockRes();

    await composed(req, res as unknown as ServerResponse, async () => {
      order.push('handler');
    });

    expect(order).toEqual(['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);
  });

  it('short-circuits when middleware does not call next', async () => {
    const order: string[] = [];

    const blocker = async (_req: IncomingMessage, _res: ServerResponse, _next: () => Promise<void>) => {
      order.push('blocked');
    };

    const after = async (_req: IncomingMessage, _res: ServerResponse, next: () => Promise<void>) => {
      order.push('should-not-run');
      await next();
    };

    const composed = composeMiddleware(blocker, after);
    const req = mockReq();
    const res = mockRes();

    await composed(req, res as unknown as ServerResponse, async () => {
      order.push('handler-should-not-run');
    });

    expect(order).toEqual(['blocked']);
  });

  it('throws when next is called multiple times', async () => {
    const badMiddleware = async (_req: IncomingMessage, _res: ServerResponse, next: () => Promise<void>) => {
      await next();
      await expect(next()).rejects.toThrow('next() called multiple times');
    };

    const composed = composeMiddleware(badMiddleware);
    const req = mockReq();
    const res = mockRes();

    await composed(req, res as unknown as ServerResponse, async () => {});
  });

  it('handles empty middleware array', async () => {
    const composed = composeMiddleware();
    const req = mockReq();
    const res = mockRes();
    let handlerCalled = false;

    await composed(req, res as unknown as ServerResponse, async () => {
      handlerCalled = true;
    });

    expect(handlerCalled).toBe(true);
  });
});

describe('Integration: Errors module', () => {
  it('all error classes have proper inheritance', () => {
    expect(new TenantNotFoundError('x')).toBeInstanceOf(MultiverseError);
    expect(new CrossTenantAccessError('a', 'b')).toBeInstanceOf(MultiverseError);
    expect(new NoTenantContextError()).toBeInstanceOf(MultiverseError);
    expect(new RateLimitExceededError('x', 1000)).toBeInstanceOf(MultiverseError);
    expect(new OutboxPublishError('msg', new Error('e'))).toBeInstanceOf(MultiverseError);
    expect(new AuthenticationError('msg')).toBeInstanceOf(MultiverseError);
    expect(new TenantResolutionError('msg')).toBeInstanceOf(MultiverseError);
    expect(new MigrationError('t', 'm', 'msg')).toBeInstanceOf(MultiverseError);
  });

  it('error classes have correct names', () => {
    const tnf = new TenantNotFoundError('x');
    expect(tnf.name).toBe('TenantNotFoundError');

    const cta = new CrossTenantAccessError('a', 'b');
    expect(cta.name).toBe('CrossTenantAccessError');
  });
});
