/**
 * Event to be written to the transactional outbox.
 */
export interface OutboxEvent {
  /** Identifier of the aggregate that produced this event */
  aggregateId: string;
  /** Type of the aggregate (e.g., 'order', 'user', 'subscription') */
  aggregateType: string;
  /** Type of the event (e.g., 'order.created', 'user.invited') */
  eventType: string;
  /** Event payload  must be JSON-serializable */
  payload: Record<string, unknown>;
  /** Optional idempotency key for consumer deduplication */
  idempotencyKey?: string;
}

/**
 * Domain event as published to the event bus (after relay picks it up from outbox).
 */
export interface DomainEvent {
  /** Unique event ID (from outbox sequence) */
  id: string;
  /** Tenant that produced this event */
  tenantId: string;
  /** Aggregate identifier */
  aggregateId: string;
  /** Aggregate type */
  aggregateType: string;
  /** Event type */
  eventType: string;
  /** Event payload */
  payload: Record<string, unknown>;
  /** Idempotency key for consumer deduplication */
  idempotencyKey: string;
  /** When the event was created */
  createdAt: Date;
}

/**
 * Handler for domain events.
 */
export type EventHandler = (event: DomainEvent) => Promise<void>;

/**
 * Raw outbox row as stored in the database.
 */
export interface OutboxRow {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: Date;
  delivered_at: Date | null;
  retry_count: number;
}
