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
 * ```
 */
export class PostgresTenantRegistry implements TenantRegistry {
  constructor(
    private readonly query: <T>(sql: string, params?: unknown[]) => Promise<T[]>,
  ) {}

  async get(id: string): Promise<Tenant | null> {
    const rows = await this.query<TenantRow>(
      'SELECT * FROM public.tenants WHERE id = $1',
      [id],
    );
    return rows[0] ? this.toTenant(rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<Tenant | null> {
    const rows = await this.query<TenantRow>(
      'SELECT * FROM public.tenants WHERE slug = $1',
      [slug],
    );
    return rows[0] ? this.toTenant(rows[0]) : null;
  }

  async list(): Promise<Tenant[]> {
    const rows = await this.query<TenantRow>(
      'SELECT * FROM public.tenants ORDER BY created_at ASC',
    );
    return rows.map((row) => this.toTenant(row));
  }

  async create(input: CreateTenantInput): Promise<Tenant> {
    const rows = await this.query<TenantRow>(
      `INSERT INTO public.tenants (id, name, slug, tier, status, config)
       VALUES ($1, $2, $3, $4, 'provisioning', $5)
       RETURNING *`,
      [input.id, input.name, input.slug, input.tier ?? 'free', JSON.stringify(input.config ?? {})],
    );
    return this.toTenant(rows[0]!);
  }

  async update(
    id: string,
    updates: Partial<Pick<Tenant, 'name' | 'slug' | 'tier' | 'status' | 'config'>>,
  ): Promise<Tenant> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.slug !== undefined) {
      setClauses.push(`slug = $${paramIndex++}`);
      params.push(updates.slug);
    }
    if (updates.tier !== undefined) {
      setClauses.push(`tier = $${paramIndex++}`);
      params.push(updates.tier);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.config !== undefined) {
      setClauses.push(`config = $${paramIndex++}`);
      params.push(JSON.stringify(updates.config));
    }

    if (setClauses.length === 0) {
      const existing = await this.get(id);
      if (!existing) throw new TenantNotFoundError(id);
      return existing;
    }

    setClauses.push(`updated_at = now()`);
    params.push(id);

    const rows = await this.query<TenantRow>(
      `UPDATE public.tenants SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params,
    );

    if (rows.length === 0) {
      throw new TenantNotFoundError(id);
    }

    return this.toTenant(rows[0]!);
  }

  async delete(id: string): Promise<void> {
    const rows = await this.query<{ id: string }>(
      'DELETE FROM public.tenants WHERE id = $1 RETURNING id',
      [id],
    );
    if (rows.length === 0) {
      throw new TenantNotFoundError(id);
    }
  }

  private toTenant(row: TenantRow): Tenant {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      tier: row.tier as Tenant['tier'],
      status: row.status as Tenant['status'],
      config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as TenantConfig,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  tier: string;
  status: string;
  config: string | Record<string, unknown>;
  created_at: string | Date;
  updated_at: string | Date;
}
