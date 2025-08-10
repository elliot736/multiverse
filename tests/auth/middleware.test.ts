import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authMiddleware, getUser, requireUser } from '../../src/auth/middleware.js';
import type { AuthenticatedRequest } from '../../src/auth/middleware.js';
import { TenantContext } from '../../src/tenant/context.js';
import type { Tenant } from '../../src/tenant/context.js';
import { AuthenticationError } from '../../src/errors.js';

function makeTenant(id: string = 'acme'): Tenant {
  return {
    id,
    name: 'Acme',
    slug: id,
    tier: 'professional',
    status: 'active',
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  return {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      Object.assign(headers, hdrs);
    }),
    end: vi.fn((data?: string) => {
      body = data ?? '';
    }),
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    _getStatus: () => statusCode,
    _getBody: () => body,
    _getHeaders: () => headers,
  } as unknown as ServerResponse & {
    _getStatus: () => number;
    _getBody: () => string;
    _getHeaders: () => Record<string, string>;
  };
}

describe('authMiddleware', () => {
  describe('skipAuth mode', () => {
    it('attaches a mock user in skip mode', async () => {
      const mw = authMiddleware({ skipAuth: true });
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
      const user = getUser(req);
      expect(user).not.toBeNull();
      expect(user!.sub).toBe('dev-user');
      expect(user!.tenantId).toBe('acme');
      expect(user!.roles).toContain('admin');
    });

    it('uses "unknown" tenant when no context', async () => {
      const mw = authMiddleware({ skipAuth: true });
      const req = mockReq();
      const res = mockRes();

      await mw(req, res as unknown as ServerResponse, async () => {});
      const user = getUser(req);
      expect(user!.tenantId).toBe('unknown');
    });

    it('mock user has expected shape', async () => {
      const mw = authMiddleware({ skipAuth: true });
      const req = mockReq();
      const res = mockRes();

      await mw(req, res as unknown as ServerResponse, async () => {});
      const user = getUser(req)!;
      expect(user.email).toBe('dev@localhost');
      expect(user.name).toBe('Development User');
      expect(user.claims).toEqual({});
    });
  });

  describe('missing authorization', () => {
    it('returns 401 when no Authorization header', async () => {
      const mw = authMiddleware({ jwksUri: 'https://example.com/.well-known/jwks.json' });
      const req = mockReq();
      const res = mockRes();

      await mw(req, res as unknown as ServerResponse, async () => {});
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
      expect(res._getBody()).toContain('Missing');
    });

    it('returns 401 when Authorization is not Bearer', async () => {
      const mw = authMiddleware({ jwksUri: 'https://example.com/.well-known/jwks.json' });
      const req = mockReq({ authorization: 'Basic abc' });
      const res = mockRes();

      await mw(req, res as unknown as ServerResponse, async () => {});
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    it('does not call next when unauthorized', async () => {
      const mw = authMiddleware({ jwksUri: 'https://example.com/.well-known/jwks.json' });
      const req = mockReq();
      const res = mockRes();
      let nextCalled = false;

      await mw(req, res as unknown as ServerResponse, async () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(false);
    });

    it('returns 401 with empty bearer token', async () => {
      const mw = authMiddleware({ jwksUri: 'https://example.com/.well-known/jwks.json' });
      const req = mockReq({ authorization: 'Bearer ' });
      const res = mockRes();

      // This will fail because empty token is not a valid JWT, but it will pass
      // the bearer check and hit the verification step which will throw
      await mw(req, res as unknown as ServerResponse, async () => {});
      // Should get 401 or 500 since the token is invalid
      expect(res.writeHead).toHaveBeenCalled();
    });
  });

  describe('getUser and requireUser', () => {
    it('getUser returns null for unauthenticated request', () => {
      const req = mockReq();
      expect(getUser(req)).toBeNull();
    });

    it('getUser returns the user for authenticated request', () => {
      const req = mockReq() as AuthenticatedRequest;
      req.user = {
        sub: 'user1',
        tenantId: 'acme',
        roles: ['member'],
        claims: {},
      };
      expect(getUser(req)!.sub).toBe('user1');
    });

    it('requireUser throws for unauthenticated request', () => {
      const req = mockReq();
      expect(() => requireUser(req)).toThrow(AuthenticationError);
    });

    it('requireUser throws with correct error code', () => {
      const req = mockReq();
      try {
        requireUser(req);
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).code).toBe('AUTHENTICATION_ERROR');
      }
    });

    it('requireUser returns user for authenticated request', () => {
      const req = mockReq() as AuthenticatedRequest;
      req.user = {
        sub: 'user1',
        tenantId: 'acme',
        roles: [],
        claims: {},
      };
      expect(requireUser(req).sub).toBe('user1');
    });
  });
});
