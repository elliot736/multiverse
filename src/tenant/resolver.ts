import type { IncomingMessage } from "node:http";
import { TenantResolutionError } from "../errors.js";

/**
 * Interface for resolving a tenant ID from an incoming HTTP request.
 * Implementations extract the tenant identifier from different parts of the request
 * (header, subdomain, path, JWT).
 */
export interface TenantResolver {
  /**
   * Attempt to resolve a tenant ID from the request.
   * Returns the tenant ID string, or null if this resolver cannot determine the tenant.
   */
  resolve(req: IncomingMessage): Promise<string | null>;
}

/**
 * Resolves tenant from a configurable HTTP header.
 * Default header: x-tenant-id
 */
export class HeaderTenantResolver implements TenantResolver {
  private readonly headerName: string;

  constructor(headerName: string = "x-tenant-id") {
    this.headerName = headerName.toLowerCase();
  }

  async resolve(req: IncomingMessage): Promise<string | null> {
    const value = req.headers[this.headerName];
    if (!value) return null;
    const tenantId = Array.isArray(value) ? value[0] : value;
    return tenantId?.trim() || null;
  }
}

/**
 * Resolves tenant from the subdomain of the Host header.
 * For example, `acme.app.example.com` with baseDomain `app.example.com`
 * resolves to `acme`.
 */
export class SubdomainTenantResolver implements TenantResolver {
  private readonly baseDomain: string;

  constructor(baseDomain: string) {
    this.baseDomain = baseDomain.toLowerCase();
  }

  async resolve(req: IncomingMessage): Promise<string | null> {
    const host = req.headers.host;
    if (!host) return null;

    // Strip port if present
    const hostname = host.split(":")[0]!.toLowerCase();

    if (!hostname.endsWith(this.baseDomain)) return null;

    // Extract subdomain: everything before the base domain
    const prefix = hostname.slice(0, hostname.length - this.baseDomain.length);
    if (!prefix || !prefix.endsWith(".")) return null;

    // Remove trailing dot
    const subdomain = prefix.slice(0, -1);
    if (!subdomain || subdomain.includes(".")) {
      // No subdomain or nested subdomains  not a direct tenant subdomain
      return null;
    }

    return subdomain;
  }
}

/**
 * Resolves tenant from a URL path segment.
 * For example, `/t/acme/api/orders` with prefix `/t/` resolves to `acme`.
 * Default: extracts the first path segment (e.g., `/acme/orders` -> `acme`).
 */
export class PathTenantResolver implements TenantResolver {
  private readonly prefix: string;

  /**
   * @param prefix - Path prefix before the tenant segment. Default: '/'
   *   Example: '/t/' means URLs look like /t/{tenantId}/...
   */
  constructor(prefix: string = "/") {
    this.prefix = prefix.endsWith("/") ? prefix : prefix + "/";
  }

  async resolve(req: IncomingMessage): Promise<string | null> {
    const url = req.url;
    if (!url) return null;

    // Parse just the pathname
    const pathname = url.split("?")[0] ?? "";
    if (!pathname.startsWith(this.prefix)) return null;

    const rest = pathname.slice(this.prefix.length);
    const segment = rest.split("/")[0];
    return segment?.trim() || null;
  }
}

/**
 * Resolves tenant from a JWT claim without verifying the token.
 * This is used for tenant resolution only  full JWT validation happens
 * in the auth middleware. The token is decoded (not verified) to extract
 * the tenant claim.
 */
export class JwtTenantResolver implements TenantResolver {
  private readonly claimName: string;

  constructor(claimName: string = "tenant_id") {
    this.claimName = claimName;
  }

  async resolve(req: IncomingMessage): Promise<string | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7);
    try {
      // Decode without verification  just extract the claim
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      const payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf-8"),
      ) as Record<string, unknown>;

      const value = payload[this.claimName];
      if (typeof value !== "string") return null;

      return value;
    } catch {
      return null;
    }
  }
}

/**
 * Tries multiple resolvers in order, returning the first non-null result.
 * Useful for supporting multiple resolution strategies simultaneously
 * (e.g., try header first, fall back to subdomain).
 */
export class ChainTenantResolver implements TenantResolver {
  private readonly resolvers: TenantResolver[];

  constructor(resolvers: TenantResolver[]) {
    if (resolvers.length === 0) {
      throw new TenantResolutionError(
        "ChainTenantResolver requires at least one resolver",
      );
    }
    this.resolvers = resolvers;
  }

  async resolve(req: IncomingMessage): Promise<string | null> {
    for (const resolver of this.resolvers) {
      const tenantId = await resolver.resolve(req);
      if (tenantId) return tenantId;
    }
    return null;
  }
}
