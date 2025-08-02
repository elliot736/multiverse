import { TenantNotFoundError } from '../errors.js';
import type { Tenant, TenantConfig } from './context.js';

export interface CreateTenantInput {
  id: string;
  name: string;
  slug: string;
  tier?: Tenant['tier'];
  config?: TenantConfig;
}

export interface TenantRegistry {
  get(id: string): Promise<Tenant | null>;
  getBySlug(slug: string): Promise<Tenant | null>;
  list(): Promise<Tenant[]>;
  create(input: CreateTenantInput): Promise<Tenant>;
  update(id: string, updates: Partial<Pick<Tenant, 'name' | 'slug' | 'tier' | 'status' | 'config'>>): Promise<Tenant>;
  delete(id: string): Promise<void>;
}

/**
 * In-memory tenant registry. Useful for testing and development.
 */
export class MemoryTenantRegistry implements TenantRegistry {
  private tenants = new Map<string, Tenant>();

  async get(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null;
  }

  async getBySlug(slug: string): Promise<Tenant | null> {
    for (const tenant of this.tenants.values()) {
      if (tenant.slug === slug) return tenant;
    }
    return null;
  }

  async list(): Promise<Tenant[]> {
    return Array.from(this.tenants.values());
  }

  async create(input: CreateTenantInput): Promise<Tenant> {
    if (this.tenants.has(input.id)) {
      throw new Error(`Tenant with id "${input.id}" already exists`);
    }

    // Check slug uniqueness
    for (const existing of this.tenants.values()) {
      if (existing.slug === input.slug) {
        throw new Error(`Tenant with slug "${input.slug}" already exists`);
      }
    }

    const now = new Date();
    const tenant: Tenant = {
      id: input.id,
      name: input.name,
      slug: input.slug,
      tier: input.tier ?? 'free',
      status: 'provisioning',
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async update(
    id: string,
    updates: Partial<Pick<Tenant, 'name' | 'slug' | 'tier' | 'status' | 'config'>>,
  ): Promise<Tenant> {
    const existing = this.tenants.get(id);
    if (!existing) {
      throw new TenantNotFoundError(id);
    }

    // Check slug uniqueness if slug is being updated
    if (updates.slug && updates.slug !== existing.slug) {
      for (const t of this.tenants.values()) {
        if (t.slug === updates.slug) {
          throw new Error(`Tenant with slug "${updates.slug}" already exists`);
        }
      }
    }

    const updated: Tenant = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };

    this.tenants.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!this.tenants.has(id)) {
      throw new TenantNotFoundError(id);
    }
    this.tenants.delete(id);
  }
}

/**
 * PostgreSQL-backed tenant registry. Stores tenant metadata in the public schema.
 *
 * Expects a table:
 * ```sql
 * CREATE TABLE public.tenants (
 *   id TEXT PRIMARY KEY,
 *   name TEXT NOT NULL,
 *   slug TEXT UNIQUE NOT NULL,
 *   tier TEXT NOT NULL DEFAULT 'free',
 *   status TEXT NOT NULL DEFAULT 'provisioning',
 *   config JSONB NOT NULL DEFAULT '{}',
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
