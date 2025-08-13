import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryEventBus } from '../../src/events/bus.js';
import type { DomainEvent } from '../../src/events/types.js';

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: '1',
    tenantId: 'acme',
    aggregateId: 'agg-1',
    aggregateType: 'order',
    eventType: 'order.created',
    payload: {},
    idempotencyKey: 'k1',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('InMemoryEventBus', () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  describe('subscribe and publish', () => {
    it('delivers events to matching handler', async () => {
      const received: DomainEvent[] = [];
      bus.subscribe('order.created', async (event) => {
        received.push(event);
      });

      await bus.publish(makeEvent());
      expect(received).toHaveLength(1);
      expect(received[0]!.eventType).toBe('order.created');
    });

    it('does not deliver events to non-matching handler', async () => {
      const received: DomainEvent[] = [];
      bus.subscribe('order.shipped', async (event) => {
        received.push(event);
      });

      await bus.publish(makeEvent({ eventType: 'order.created' }));
      expect(received).toHaveLength(0);
    });

    it('delivers to multiple handlers for the same event type', async () => {
      let count = 0;
      bus.subscribe('order.created', async () => { count++; });
      bus.subscribe('order.created', async () => { count++; });

      await bus.publish(makeEvent());
      expect(count).toBe(2);
    });

    it('delivers to handlers for different event types', async () => {
      const createdEvents: DomainEvent[] = [];
      const shippedEvents: DomainEvent[] = [];

      bus.subscribe('order.created', async (e) => createdEvents.push(e));
      bus.subscribe('order.shipped', async (e) => shippedEvents.push(e));

      await bus.publish(makeEvent({ eventType: 'order.created' }));
      await bus.publish(makeEvent({ eventType: 'order.shipped' }));

      expect(createdEvents).toHaveLength(1);
      expect(shippedEvents).toHaveLength(1);
    });
  });

  describe('wildcard handler', () => {
    it('receives all events', async () => {
      const all: string[] = [];
      bus.subscribe('*', async (event) => {
        all.push(event.eventType);
      });

      await bus.publish(makeEvent({ eventType: 'a' }));
      await bus.publish(makeEvent({ eventType: 'b' }));
      await bus.publish(makeEvent({ eventType: 'c' }));

      expect(all).toEqual(['a', 'b', 'c']);
    });

    it('is called in addition to type-specific handlers', async () => {
      const specific: string[] = [];
      const wildcard: string[] = [];

      bus.subscribe('order.created', async (e) => specific.push(e.eventType));
      bus.subscribe('*', async (e) => wildcard.push(e.eventType));

      await bus.publish(makeEvent({ eventType: 'order.created' }));

      expect(specific).toEqual(['order.created']);
      expect(wildcard).toEqual(['order.created']);
    });
  });

  describe('unsubscribe', () => {
    it('stops delivery after unsubscribe', async () => {
      const received: string[] = [];
      const handler = async (e: DomainEvent) => { received.push(e.eventType); };

      bus.subscribe('test', handler);
      await bus.publish(makeEvent({ eventType: 'test' }));

      bus.unsubscribe('test', handler);
      await bus.publish(makeEvent({ eventType: 'test' }));

      expect(received).toHaveLength(1);
    });

    it('only removes the specific handler', async () => {
      let count1 = 0;
      let count2 = 0;
      const handler1 = async () => { count1++; };
      const handler2 = async () => { count2++; };

      bus.subscribe('test', handler1);
      bus.subscribe('test', handler2);
      bus.unsubscribe('test', handler1);

      await bus.publish(makeEvent({ eventType: 'test' }));

      expect(count1).toBe(0);
      expect(count2).toBe(1);
    });

    it('unsubscribes wildcard handler', async () => {
      const received: string[] = [];
      const handler = async (e: DomainEvent) => { received.push(e.eventType); };

      bus.subscribe('*', handler);
      await bus.publish(makeEvent({ eventType: 'a' }));

      bus.unsubscribe('*', handler);
      await bus.publish(makeEvent({ eventType: 'b' }));

      expect(received).toEqual(['a']);
    });

    it('is safe to unsubscribe a handler that was never subscribed', () => {
      const handler = async () => {};
      // Should not throw
      bus.unsubscribe('nonexistent', handler);
    });

    it('cleans up event type when last handler is removed', () => {
      const handler = async () => {};
      bus.subscribe('test', handler);
      expect(bus.handlerCount('test')).toBe(1);
      bus.unsubscribe('test', handler);
      expect(bus.handlerCount('test')).toBe(0);
    });
  });

  describe('error handling', () => {
    it('error in one handler does not prevent other handlers from running', async () => {
      let secondCalled = false;

      bus.subscribe('test', async () => {
        throw new Error('handler 1 failed');
      });
      bus.subscribe('test', async () => {
        secondCalled = true;
      });

      await expect(bus.publish(makeEvent({ eventType: 'test' }))).rejects.toThrow('handler 1 failed');
      expect(secondCalled).toBe(true);
    });

    it('rethrows the first error after all handlers run', async () => {
      bus.subscribe('test', async () => { throw new Error('first error'); });
      bus.subscribe('test', async () => { throw new Error('second error'); });

      await expect(bus.publish(makeEvent({ eventType: 'test' }))).rejects.toThrow('first error');
    });

    it('error in type handler does not prevent wildcard handler', async () => {
      let wildcardCalled = false;

      bus.subscribe('test', async () => { throw new Error('fail'); });
      bus.subscribe('*', async () => { wildcardCalled = true; });

      try { await bus.publish(makeEvent({ eventType: 'test' })); } catch { /* expected */ }
      expect(wildcardCalled).toBe(true);
    });

    it('error in wildcard handler does not prevent type handler', async () => {
      let typeCalled = false;

      bus.subscribe('test', async () => { typeCalled = true; });
      bus.subscribe('*', async () => { throw new Error('wildcard fail'); });

      // Type handler runs first, so it will be called
      try { await bus.publish(makeEvent({ eventType: 'test' })); } catch { /* expected */ }
      expect(typeCalled).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all handlers', async () => {
      bus.subscribe('a', async () => {});
      bus.subscribe('b', async () => {});
      bus.subscribe('*', async () => {});

      bus.clear();

      expect(bus.handlerCount('a')).toBe(0);
      expect(bus.handlerCount('b')).toBe(0);
      expect(bus.handlerCount('*')).toBe(0);
    });
  });

  describe('handlerCount', () => {
    it('returns 0 for unregistered event types', () => {
      expect(bus.handlerCount('nope')).toBe(0);
    });

    it('returns correct count', () => {
      bus.subscribe('test', async () => {});
      bus.subscribe('test', async () => {});
      expect(bus.handlerCount('test')).toBe(2);
    });

    it('returns wildcard count', () => {
      bus.subscribe('*', async () => {});
      expect(bus.handlerCount('*')).toBe(1);
    });
  });

  describe('async handlers', () => {
    it('awaits async handlers', async () => {
      const order: number[] = [];

      bus.subscribe('test', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      });
      bus.subscribe('test', async () => {
        order.push(2);
      });

      await bus.publish(makeEvent({ eventType: 'test' }));
      expect(order).toEqual([1, 2]);
    });
  });
});
