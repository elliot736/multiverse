import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  HeaderTenantResolver,
  SubdomainTenantResolver,
  PathTenantResolver,
  JwtTenantResolver,
  ChainTenantResolver,
} from '../../src/tenant/resolver.js';
import { TenantResolutionError } from '../../src/errors.js';

function mockRequest(overrides: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
} = {}): IncomingMessage {
  return {
    headers: overrides.headers ?? {},
    url: overrides.url ?? '/',
  } as unknown as IncomingMessage;
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('HeaderTenantResolver', () => {
  it('resolves tenant from default header (x-tenant-id)', async () => {
    const resolver = new HeaderTenantResolver();
    const req = mockRequest({ headers: { 'x-tenant-id': 'acme' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('resolves tenant from custom header', async () => {
    const resolver = new HeaderTenantResolver('X-Organization');
    const req = mockRequest({ headers: { 'x-organization': 'globex' } });
    expect(await resolver.resolve(req)).toBe('globex');
  });

  it('returns null when header is missing', async () => {
    const resolver = new HeaderTenantResolver();
    const req = mockRequest({ headers: {} });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('handles array-valued headers (takes first)', async () => {
    const resolver = new HeaderTenantResolver();
    const req = mockRequest({ headers: { 'x-tenant-id': ['first', 'second'] as unknown as string } });
    expect(await resolver.resolve(req)).toBe('first');
  });

  it('returns null for empty header value', async () => {
    const resolver = new HeaderTenantResolver();
    const req = mockRequest({ headers: { 'x-tenant-id': '  ' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('trims whitespace from header value', async () => {
    const resolver = new HeaderTenantResolver();
    const req = mockRequest({ headers: { 'x-tenant-id': '  acme  ' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('is case-insensitive for header names', async () => {
    const resolver = new HeaderTenantResolver('X-Tenant-ID');
    const req = mockRequest({ headers: { 'x-tenant-id': 'acme' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('returns null for undefined header value', async () => {
    const resolver = new HeaderTenantResolver();
    const req = mockRequest({ headers: { 'x-tenant-id': undefined } });
    expect(await resolver.resolve(req)).toBeNull();
  });
});

describe('SubdomainTenantResolver', () => {
  it('extracts tenant from subdomain', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: { host: 'acme.app.example.com' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('returns null when no subdomain', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: { host: 'app.example.com' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null for nested subdomains (multi-level)', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: { host: 'dept.acme.app.example.com' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when host does not match base domain', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: { host: 'acme.other.com' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('strips port from host', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: { host: 'acme.app.example.com:3000' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('strips high port from host', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: { host: 'acme.app.example.com:8443' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('returns null when no host header', async () => {
    const resolver = new SubdomainTenantResolver('app.example.com');
    const req = mockRequest({ headers: {} });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('is case-insensitive', async () => {
    const resolver = new SubdomainTenantResolver('App.Example.COM');
    const req = mockRequest({ headers: { host: 'ACME.app.example.com' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('handles host with only the base domain and port', async () => {
    const resolver = new SubdomainTenantResolver('example.com');
    const req = mockRequest({ headers: { host: 'example.com:443' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('resolves with a simple base domain', async () => {
    const resolver = new SubdomainTenantResolver('example.com');
    const req = mockRequest({ headers: { host: 'acme.example.com' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('handles localhost-style domains', async () => {
    const resolver = new SubdomainTenantResolver('localhost');
    const req = mockRequest({ headers: { host: 'acme.localhost:3000' } });
    expect(await resolver.resolve(req)).toBe('acme');
  });
});

describe('PathTenantResolver', () => {
  it('extracts tenant from first path segment by default', async () => {
    const resolver = new PathTenantResolver();
    const req = mockRequest({ url: '/acme/api/orders' });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('extracts tenant from custom prefix', async () => {
    const resolver = new PathTenantResolver('/t/');
    const req = mockRequest({ url: '/t/globex/api/users' });
    expect(await resolver.resolve(req)).toBe('globex');
  });

  it('works with prefix without trailing slash', async () => {
    const resolver = new PathTenantResolver('/orgs');
    const req = mockRequest({ url: '/orgs/acme/dashboard' });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('returns null when path does not match prefix', async () => {
    const resolver = new PathTenantResolver('/t/');
    const req = mockRequest({ url: '/api/health' });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null for empty path segment', async () => {
    const resolver = new PathTenantResolver();
    const req = mockRequest({ url: '/' });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('ignores query parameters', async () => {
    const resolver = new PathTenantResolver();
    const req = mockRequest({ url: '/acme?foo=bar' });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('returns null when url is missing', async () => {
    const resolver = new PathTenantResolver();
    const req = mockRequest({});
    (req as { url?: string }).url = undefined;
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null for whitespace-only segment', async () => {
    const resolver = new PathTenantResolver();
    const req = mockRequest({ url: '/   ' });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('handles url with only the prefix and no tenant', async () => {
    const resolver = new PathTenantResolver('/t/');
    const req = mockRequest({ url: '/t/' });
    expect(await resolver.resolve(req)).toBeNull();
  });
});

describe('JwtTenantResolver', () => {
  it('extracts tenant from JWT claim', async () => {
    const resolver = new JwtTenantResolver();
    const token = makeJwt({ sub: 'user1', tenant_id: 'acme' });
    const req = mockRequest({ headers: { authorization: `Bearer ${token}` } });
    expect(await resolver.resolve(req)).toBe('acme');
  });

  it('extracts tenant from custom claim name', async () => {
    const resolver = new JwtTenantResolver('org_id');
    const token = makeJwt({ sub: 'user1', org_id: 'globex' });
    const req = mockRequest({ headers: { authorization: `Bearer ${token}` } });
    expect(await resolver.resolve(req)).toBe('globex');
  });

  it('returns null when no authorization header', async () => {
    const resolver = new JwtTenantResolver();
    const req = mockRequest({ headers: {} });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when authorization is not Bearer', async () => {
    const resolver = new JwtTenantResolver();
    const req = mockRequest({ headers: { authorization: 'Basic abc123' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when JWT is malformed', async () => {
    const resolver = new JwtTenantResolver();
    const req = mockRequest({ headers: { authorization: 'Bearer not.a.jwt!!!' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when JWT has wrong number of parts', async () => {
    const resolver = new JwtTenantResolver();
    const req = mockRequest({ headers: { authorization: 'Bearer only.two' } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when claim is missing', async () => {
    const resolver = new JwtTenantResolver();
    const token = makeJwt({ sub: 'user1' });
    const req = mockRequest({ headers: { authorization: `Bearer ${token}` } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when claim is not a string', async () => {
    const resolver = new JwtTenantResolver();
    const token = makeJwt({ sub: 'user1', tenant_id: 42 });
    const req = mockRequest({ headers: { authorization: `Bearer ${token}` } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when claim is boolean', async () => {
    const resolver = new JwtTenantResolver();
    const token = makeJwt({ sub: 'user1', tenant_id: true });
    const req = mockRequest({ headers: { authorization: `Bearer ${token}` } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when claim is null', async () => {
    const resolver = new JwtTenantResolver();
    const token = makeJwt({ sub: 'user1', tenant_id: null });
    const req = mockRequest({ headers: { authorization: `Bearer ${token}` } });
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('handles JWT with empty bearer prefix', async () => {
    const resolver = new JwtTenantResolver();
    const req = mockRequest({ headers: { authorization: 'Bearer ' } });
    expect(await resolver.resolve(req)).toBeNull();
  });
});

describe('ChainTenantResolver', () => {
  it('returns result from first resolver that matches', async () => {
    const chain = new ChainTenantResolver([
      new HeaderTenantResolver(),
      new PathTenantResolver(),
    ]);
    const req = mockRequest({
      headers: { 'x-tenant-id': 'from-header' },
      url: '/from-path/api',
    });
    expect(await chain.resolve(req)).toBe('from-header');
  });

  it('falls back to second resolver when first returns null', async () => {
    const chain = new ChainTenantResolver([
      new HeaderTenantResolver(),
      new PathTenantResolver(),
    ]);
    const req = mockRequest({ url: '/from-path/api' });
    expect(await chain.resolve(req)).toBe('from-path');
  });

  it('falls back through three resolvers', async () => {
    const chain = new ChainTenantResolver([
      new HeaderTenantResolver(),
      new SubdomainTenantResolver('app.example.com'),
      new PathTenantResolver(),
    ]);
    const req = mockRequest({ url: '/fallback-path/api' });
    expect(await chain.resolve(req)).toBe('fallback-path');
  });

  it('returns null when no resolver matches', async () => {
    const chain = new ChainTenantResolver([
      new HeaderTenantResolver(),
      new SubdomainTenantResolver('app.example.com'),
    ]);
    const req = mockRequest({ url: '/test' });
    expect(await chain.resolve(req)).toBeNull();
  });

  it('throws when constructed with empty array', () => {
    expect(() => new ChainTenantResolver([])).toThrow(TenantResolutionError);
    expect(() => new ChainTenantResolver([])).toThrow(
      'ChainTenantResolver requires at least one resolver',
    );
  });

  it('works with a single resolver', async () => {
    const chain = new ChainTenantResolver([new HeaderTenantResolver()]);
    const req = mockRequest({ headers: { 'x-tenant-id': 'solo' } });
    expect(await chain.resolve(req)).toBe('solo');
  });

  it('stops at first match and does not call later resolvers', async () => {
    let secondCalled = false;
    const customResolver = {
      async resolve() {
        secondCalled = true;
        return 'should-not-reach';
      },
    };

    const chain = new ChainTenantResolver([
      new HeaderTenantResolver(),
      customResolver,
    ]);
    const req = mockRequest({ headers: { 'x-tenant-id': 'first' } });
    await chain.resolve(req);
    expect(secondCalled).toBe(false);
  });
});
