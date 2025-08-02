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
