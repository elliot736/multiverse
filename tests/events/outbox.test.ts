import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Outbox } from '../../src/events/outbox.js';
import { OutboxPublishError } from '../../src/errors.js';
import type { OutboxEvent } from '../../src/events/types.js';

function createMockClient() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _queries: queries,
  };
}

describe('Outbox', () => {
  let outbox: Outbox;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    outbox = new Outbox();
    client = createMockClient();
  });

  describe('publish', () => {
    it('inserts an event into the _outbox table', async () => {
      const event: OutboxEvent = {
        aggregateId: 'order-123',
        aggregateType: 'order',
        eventType: 'order.created',
        payload: { total: 99.99, currency: 'USD' },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await outbox.publish(client as any, event);

      expect(client.query).toHaveBeenCalledTimes(1);
      const [sql, params] = [client._queries[0]!.sql, client._queries[0]!.params!];
      expect(sql).toContain('INSERT INTO _outbox');
      expect(params[0]).toBe('order-123');
      expect(params[1]).toBe('order');
      expect(params[2]).toBe('order.created');
      expect(JSON.parse(params[3] as string)).toEqual({ total: 99.99, currency: 'USD' });
      expect(typeof params[4]).toBe('string');
      expect((params[4] as string).length).toBeGreaterThan(0);
    });

    it('uses provided idempotency key', async () => {
      const event: OutboxEvent = {
        aggregateId: 'order-123',
        aggregateType: 'order',
        eventType: 'order.created',
        payload: {},
        idempotencyKey: 'my-custom-key',
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await outbox.publish(client as any, event);

      const params = client._queries[0]!.params!;
      expect(params[4]).toBe('my-custom-key');
    });

    it('generates unique idempotency keys when not provided', async () => {
      const event: OutboxEvent = {
        aggregateId: 'order-1',
        aggregateType: 'order',
        eventType: 'order.created',
        payload: {},
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await outbox.publish(client as any, event);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await outbox.publish(client as any, event);

      const key1 = client._queries[0]!.params![4] as string;
      const key2 = client._queries[1]!.params![4] as string;
      expect(key1).not.toBe(key2);
    });

    it('wraps database errors in OutboxPublishError', async () => {
      client.query.mockRejectedValueOnce(new Error('connection lost'));

      const event: OutboxEvent = {
        aggregateId: 'order-456',
        aggregateType: 'order',
        eventType: 'order.shipped',
        payload: {},
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(outbox.publish(client as any, event)).rejects.toThrow(OutboxPublishError);
    });

    it('OutboxPublishError includes original error', async () => {
      const originalError = new Error('connection lost');
      client.query.mockRejectedValueOnce(originalError);

      const event: OutboxEvent = {
        aggregateId: 'order-456',
        aggregateType: 'order',
        eventType: 'order.shipped',
        payload: {},
      };

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await outbox.publish(client as any, event);
      } catch (err) {
        expect(err).toBeInstanceOf(OutboxPublishError);
        expect((err as OutboxPublishError).originalError).toBe(originalError);
        expect((err as OutboxPublishError).code).toBe('OUTBOX_PUBLISH_ERROR');
      }
    });

    it('serializes complex payloads', async () => {
      const event: OutboxEvent = {
        aggregateId: 'inv-1',
        aggregateType: 'invoice',
        eventType: 'invoice.finalized',
        payload: {
          lineItems: [
