import type { DomainEvent, EventHandler } from './types.js';

/**
 * Interface for an event bus that distributes domain events to subscribers.
 * Implementations may be in-memory, Kafka, SQS, etc.
 */
export interface EventBus {
  /**
   * Publish a domain event to all subscribers of the event type.
   */
  publish(event: DomainEvent): Promise<void>;

  /**
   * Subscribe to events of a specific type.
   * Use '*' to subscribe to all event types.
   */
  subscribe(eventType: string, handler: EventHandler): void;

  /**
   * Remove a specific handler for an event type.
   */
  unsubscribe(eventType: string, handler: EventHandler): void;
}

/**
 * In-memory event bus implementation.
 * Suitable for single-process applications and testing.
 *
 * Events are dispatched synchronously to all matching handlers.
 * Handler errors are collected and the first one is re-thrown after
 * all handlers have been called.
 */
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wildcardHandlers = new Set<EventHandler>();

  async publish(event: DomainEvent): Promise<void> {
    const errors: Error[] = [];

    // Call type-specific handlers
    const typeHandlers = this.handlers.get(event.eventType);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(event);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    // Call wildcard handlers
    for (const handler of this.wildcardHandlers) {
      try {
        await handler(event);
