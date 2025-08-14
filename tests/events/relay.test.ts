import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxRelay } from '../../src/events/relay.js';
import { InMemoryEventBus } from '../../src/events/bus.js';
import type { TenantPool } from '../../src/db/pool.js';
import type { DomainEvent, OutboxRow } from '../../src/events/types.js';

function makeOutboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: '1',
    aggregate_id: 'agg-1',
    aggregate_type: 'order',
    event_type: 'order.created',
    payload: { total: 42 },
    idempotency_key: 'key-1',
    created_at: new Date('2025-06-01'),
    delivered_at: null,
    retry_count: 0,
    ...overrides,
  };
}

function createMockPoolAndClient(
  schemas: Array<{ schema_name: string }> = [],
  outboxRows: OutboxRow[] = [],
) {
  const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];

  const mockClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executedQueries.push({ sql, params });
      if (sql.includes('SELECT * FROM _outbox')) {
        return { rows: outboxRows, rowCount: outboxRows.length };
      }
      if (sql.includes('UPDATE _outbox SET delivered_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE _outbox SET retry_count')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM _outbox')) {
        return { rows: [{ id: '1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _executedQueries: executedQueries,
  };

  const pool = {
    getConnection: vi.fn(async () => mockClient),
    queryPublic: vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.schemata')) {
        return schemas;
      }
      return [];
    }),
  } as unknown as TenantPool;

  return { pool, mockClient };
}

describe('OutboxRelay', () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  describe('pollOnce', () => {
    it('processes undelivered events from all tenant schemas', async () => {
      const rows = [
        makeOutboxRow({ id: '1', event_type: 'order.created' }),
        makeOutboxRow({ id: '2', event_type: 'order.shipped' }),
      ];

      const { pool } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        rows,
      );

      const publishedEvents: DomainEvent[] = [];
      bus.subscribe('*', async (event) => {
        publishedEvents.push(event);
      });

      const relay = new OutboxRelay(pool, bus, { pollIntervalMs: 100 });
      const result = await relay.pollOnce();

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);
      expect(publishedEvents).toHaveLength(2);
      expect(publishedEvents[0]!.tenantId).toBe('acme');
      expect(publishedEvents[0]!.eventType).toBe('order.created');
      expect(publishedEvents[1]!.eventType).toBe('order.shipped');
    });

    it('marks events as delivered after successful publish', async () => {
      const { pool, mockClient } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [makeOutboxRow({ id: '42' })],
      );

      const relay = new OutboxRelay(pool, bus);
      await relay.pollOnce();

      const deliverQueries = mockClient._executedQueries.filter(
        (q) => q.sql.includes('UPDATE _outbox SET delivered_at'),
      );
      expect(deliverQueries).toHaveLength(1);
      expect(deliverQueries[0]!.params).toEqual(['42']);
    });

    it('increments retry count on publish failure', async () => {
      const { pool, mockClient } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [makeOutboxRow({ id: '99' })],
      );

      bus.subscribe('order.created', async () => {
        throw new Error('handler failed');
      });

      const relay = new OutboxRelay(pool, bus);
      const result = await relay.pollOnce();

      expect(result.failed).toBe(1);
      expect(result.processed).toBe(0);

      const retryQueries = mockClient._executedQueries.filter(
        (q) => q.sql.includes('UPDATE _outbox SET retry_count'),
      );
      expect(retryQueries).toHaveLength(1);
      expect(retryQueries[0]!.params).toEqual(['99']);
    });

    it('handles multiple tenant schemas', async () => {
      const { pool } = createMockPoolAndClient(
        [
          { schema_name: 'tenant_acme' },
          { schema_name: 'tenant_globex' },
          { schema_name: 'tenant_initech' },
        ],
        [makeOutboxRow()],
      );

      const events: DomainEvent[] = [];
      bus.subscribe('*', async (e) => events.push(e));

      const relay = new OutboxRelay(pool, bus);
      const result = await relay.pollOnce();

      expect(result.processed).toBe(3);
      expect(events.map((e) => e.tenantId).sort()).toEqual(['acme', 'globex', 'initech']);
    });

    it('continues processing other tenants when one fails', async () => {
      let callCount = 0;
      const pool = {
        getConnection: vi.fn(async () => {
          callCount++;
          if (callCount === 1) throw new Error('tenant_acme unavailable');
          return {
            query: vi.fn(async (sql: string) => {
              if (sql.includes('SELECT * FROM _outbox')) {
                return { rows: [makeOutboxRow()], rowCount: 1 };
              }
              return { rows: [], rowCount: 0 };
            }),
            release: vi.fn(),
          };
        }),
        queryPublic: vi.fn(async () => [
          { schema_name: 'tenant_acme' },
          { schema_name: 'tenant_globex' },
        ]),
      } as unknown as TenantPool;

      const relay = new OutboxRelay(pool, bus);
      const result = await relay.pollOnce();

      expect(result.tenantErrors).toHaveLength(1);
      expect(result.tenantErrors[0]!.tenantId).toBe('acme');
      expect(result.processed).toBe(1);
    });

    it('returns empty result when no schemas exist', async () => {
      const { pool } = createMockPoolAndClient([], []);
      const relay = new OutboxRelay(pool, bus);
      const result = await relay.pollOnce();

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.tenantErrors).toHaveLength(0);
    });

    it('handles schema discovery error', async () => {
      const pool = {
        getConnection: vi.fn(),
        queryPublic: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
      } as unknown as TenantPool;

      const relay = new OutboxRelay(pool, bus);
      const result = await relay.pollOnce();

      expect(result.tenantErrors).toHaveLength(1);
      expect(result.tenantErrors[0]!.tenantId).toBe('__discovery__');
    });

    it('handles empty outbox for a tenant', async () => {
      const { pool } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [], // No outbox rows
      );

      const relay = new OutboxRelay(pool, bus);
      const result = await relay.pollOnce();

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  describe('start and stop', () => {
    it('starts and stops the relay', async () => {
      const { pool } = createMockPoolAndClient([], []);
      const relay = new OutboxRelay(pool, bus, { pollIntervalMs: 50 });

      await relay.start();
      expect(relay.isRunning).toBe(true);

      await relay.stop();
      expect(relay.isRunning).toBe(false);
    });

    it('is idempotent on start', async () => {
      const { pool } = createMockPoolAndClient([], []);
      const relay = new OutboxRelay(pool, bus, { pollIntervalMs: 50 });

      await relay.start();
      await relay.start();
      await relay.stop();
    });

    it('stop is safe to call without start', async () => {
      const { pool } = createMockPoolAndClient([], []);
      const relay = new OutboxRelay(pool, bus);
      await relay.stop(); // Should not throw
    });
  });

  describe('event mapping', () => {
    it('correctly maps outbox rows to domain events', async () => {
      const row = makeOutboxRow({
        id: '77',
        aggregate_id: 'inv-42',
        aggregate_type: 'invoice',
        event_type: 'invoice.paid',
        payload: { amount: 150.00, currency: 'EUR' },
        idempotency_key: 'idem-77',
        created_at: new Date('2025-03-15T10:30:00Z'),
      });

      const { pool } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [row],
      );

      const events: DomainEvent[] = [];
      bus.subscribe('*', async (e) => events.push(e));

      const relay = new OutboxRelay(pool, bus);
      await relay.pollOnce();

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.id).toBe('77');
      expect(event.tenantId).toBe('acme');
      expect(event.aggregateId).toBe('inv-42');
      expect(event.aggregateType).toBe('invoice');
      expect(event.eventType).toBe('invoice.paid');
      expect(event.payload).toEqual({ amount: 150.00, currency: 'EUR' });
      expect(event.idempotencyKey).toBe('idem-77');
      expect(event.createdAt).toEqual(new Date('2025-03-15T10:30:00Z'));
    });

    it('uses row id as idempotency key when null', async () => {
      const row = makeOutboxRow({ id: '55', idempotency_key: null });

      const { pool } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [row],
      );

      const events: DomainEvent[] = [];
      bus.subscribe('*', async (e) => events.push(e));

      const relay = new OutboxRelay(pool, bus);
      await relay.pollOnce();

      expect(events[0]!.idempotencyKey).toBe('55');
    });

    it('handles string payload that needs parsing', async () => {
      const row = makeOutboxRow({
        payload: '{"key": "value"}' as unknown as Record<string, unknown>,
      });

      const { pool } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [row],
      );

      const events: DomainEvent[] = [];
      bus.subscribe('*', async (e) => events.push(e));

      const relay = new OutboxRelay(pool, bus);
      await relay.pollOnce();

      expect(events[0]!.payload).toEqual({ key: 'value' });
    });
  });

  describe('batch processing', () => {
    it('processes events in order within a tenant', async () => {
      const rows = [
        makeOutboxRow({ id: '1', event_type: 'first' }),
        makeOutboxRow({ id: '2', event_type: 'second' }),
        makeOutboxRow({ id: '3', event_type: 'third' }),
      ];

      const { pool } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        rows,
      );

      const eventTypes: string[] = [];
      bus.subscribe('*', async (e) => eventTypes.push(e.eventType));

      const relay = new OutboxRelay(pool, bus);
      await relay.pollOnce();

      expect(eventTypes).toEqual(['first', 'second', 'third']);
    });
  });

  describe('cleanup', () => {
    it('deletes old delivered events', async () => {
      const { pool, mockClient } = createMockPoolAndClient(
        [{ schema_name: 'tenant_acme' }],
        [],
      );

      // For cleanup, queryPublic needs to return schemas
      (pool.queryPublic as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.schemata')) {
          return [{ schema_name: 'tenant_acme' }];
        }
        return [];
      });

      const relay = new OutboxRelay(pool, bus);
      const cleaned = await relay.cleanup();

      expect(cleaned).toBeGreaterThanOrEqual(0);
      const deleteQueries = mockClient._executedQueries.filter(
        (q) => q.sql.includes('DELETE FROM _outbox'),
      );
      expect(deleteQueries).toHaveLength(1);
    });
  });
});
