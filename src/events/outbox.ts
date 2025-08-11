import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { OutboxPublishError } from '../errors.js';
import type { OutboxEvent } from './types.js';

/**
 * Transactional outbox for reliable event publishing.
 *
 * Events are written to the `_outbox` table in the same database transaction
 * as the business data. This guarantees atomicity: either both the business
 * data and the event are persisted, or neither is.
 *
 * The OutboxRelay is responsible for reading events from the outbox and
 * publishing them to the event bus.
 *
 * Usage:
 * ```typescript
 * await pool.transaction(tenantId, async (client) => {
 *   // Business logic
 *   await client.query('INSERT INTO orders ...');
 *
 *   // Publish event in the same transaction
 *   await outbox.publish(client, {
 *     aggregateId: orderId,
 *     aggregateType: 'order',
 *     eventType: 'order.created',
 *     payload: { orderId, items, total },
 *   });
 * });
 * // Both the order and the event are committed atomically
 * ```
 */
export class Outbox {
  /**
   * Write a single event to the outbox table using the provided transaction client.
   *
   * IMPORTANT: The client must be within an active transaction. The event is only
   * visible after the transaction commits.
   */
  async publish(client: PoolClient, event: OutboxEvent): Promise<void> {
    const idempotencyKey = event.idempotencyKey ?? randomUUID();

    try {
      await client.query(
        `INSERT INTO _outbox (aggregate_id, aggregate_type, event_type, payload, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          event.aggregateId,
          event.aggregateType,
          event.eventType,
          JSON.stringify(event.payload),
          idempotencyKey,
        ],
      );
    } catch (err) {
      throw new OutboxPublishError(
        `Failed to write event ${event.eventType} for aggregate ${event.aggregateId}`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Write multiple events to the outbox table in a single batch.
   * All events are written using the same transaction client.
   */
  async publishMany(client: PoolClient, events: OutboxEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Build a single multi-row INSERT for efficiency
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const offset = i * 5;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
      );
      values.push(
        event.aggregateId,
        event.aggregateType,
        event.eventType,
        JSON.stringify(event.payload),
        event.idempotencyKey ?? randomUUID(),
      );
    }

    try {
      await client.query(
        `INSERT INTO _outbox (aggregate_id, aggregate_type, event_type, payload, idempotency_key)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (err) {
      throw new OutboxPublishError(
        `Failed to write ${events.length} events in batch`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}
