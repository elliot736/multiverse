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
