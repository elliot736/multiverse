# ADR-002: Transactional Outbox for Event Publishing

## Status

Accepted

## Date

2025-08-22

## Context

Domain events are central to a SaaS platform: tenant provisioned, user invited, subscription changed, invoice generated. These events must be reliably delivered to consumers (other services, webhooks, analytics pipelines).

The naive approach is to write to the database and then publish to a message broker (Kafka, SQS, RabbitMQ):

```
BEGIN;
  INSERT INTO orders (...) VALUES (...);
COMMIT;
-- crash here = lost event
await kafka.publish({ type: 'order.created', ... });
```

If the application crashes between the commit and the publish, the event is lost. The database has the order, but no consumer ever learns about it. The reverse order (publish then commit) is worse: the event is delivered but the data may not be persisted.

Two-phase commit (2PC/XA) solves this in theory but is impractical: most message brokers do not support XA, it adds latency, and it couples the database and broker availability.

## Decision

We implement the **transactional outbox pattern**.

1. Events are written to an `_outbox` table in the **same database transaction** as the business data. Since both writes are in the same transaction, they are atomic: either both succeed or neither does.

2. A **relay process** polls the `_outbox` table (or uses Postgres `LISTEN/NOTIFY` as an optimization) and publishes events to the event bus. After successful publication, it marks events as delivered.

3. Each tenant schema has its own `_outbox` table. The relay iterates all tenant schemas.

The outbox table schema:

```sql
CREATE TABLE _outbox (
  id            BIGSERIAL PRIMARY KEY,
  aggregate_id   TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  idempotency_key TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ,
  retry_count    INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_undelivered ON _outbox (id) WHERE delivered_at IS NULL;
```

## Trade-offs

### Advantages

- **Atomicity without 2PC.** Business data and events share a transaction boundary. No data/event inconsistency possible.
- **At-least-once delivery.** If the relay crashes after reading but before marking delivered, it will re-read and re-publish on restart. Events are never lost.
- **Ordering guarantees.** Events for the same aggregate are ordered by `id` (a sequence), which is monotonically increasing within a transaction. Consumers can process in order per aggregate.
- **Broker-agnostic.** The outbox pattern decouples the write path from the broker. Switching from an in-memory bus to Kafka only requires a new `EventBus` implementation; the outbox and application code are unchanged.

### Disadvantages

- **Delivery latency.** Events are not published in real-time; they are published on the next relay poll cycle. Default poll interval is 1 second, which is acceptable for most SaaS use cases but not for sub-100ms requirements.
- **Outbox table growth.** Delivered events accumulate. The relay must periodically clean up old delivered events (or the application must archive them). We provide a `cleanup` method on the relay.
- **Duplicate delivery.** At-least-once means consumers may see the same event twice. We include an `idempotency_key` on every event so consumers can deduplicate.
- **Poll load.** Polling across many tenant schemas adds database load. We mitigate this by querying only for undelivered events (indexed) and batching.

## Consequences

1. The `Outbox` class provides `publish(client, event)` and `publishMany(client, events)` methods that write to the `_outbox` table using the provided transaction client.
2. The `OutboxRelay` polls all tenant schemas on a configurable interval, reads undelivered events in batches, publishes them to the `EventBus`, and marks them delivered.
3. Consumers must be idempotent. The framework provides `idempotencyKey` on every event to support deduplication.
4. The `TenantMigrator` must create the `_outbox` table as part of the base schema for every tenant.
5. The relay must handle per-tenant failures gracefully: if one tenant's schema is unreachable, it should log the error and continue to other tenants.
