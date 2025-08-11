import type { TenantPool } from '../db/pool.js';
import type { EventBus } from './bus.js';
import type { DomainEvent, OutboxRow } from './types.js';

export interface RelayOptions {
  /** Polling interval in milliseconds. Default: 1000 */
  pollIntervalMs?: number;
  /** Maximum events to process per poll cycle per tenant. Default: 100 */
  batchSize?: number;
  /** Maximum retry attempts before marking an event as failed. Default: 3 */
  maxRetries?: number;
  /** Base backoff delay for retries in milliseconds. Default: 1000 */
  retryBackoffMs?: number;
  /** Maximum age of delivered events before cleanup, in milliseconds. Default: 7 days */
  cleanupAfterMs?: number;
}

const DEFAULT_OPTIONS: Required<RelayOptions> = {
  pollIntervalMs: 1000,
  batchSize: 100,
  maxRetries: 3,
  retryBackoffMs: 1000,
  cleanupAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Outbox relay that polls the outbox tables across all tenant schemas
 * and publishes events to the event bus.
 *
 * The relay:
 * 1. Discovers all tenant schemas
 * 2. For each schema, reads undelivered events in batches
 * 3. Publishes each event to the EventBus
 * 4. Marks successfully published events as delivered
 * 5. Retries failed events with exponential backoff
 * 6. Periodically cleans up old delivered events
 */
export class OutboxRelay {
  private readonly options: Required<RelayOptions>;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPoll: Promise<void> | null = null;

  constructor(
    private readonly pool: TenantPool,
    private readonly bus: EventBus,
    options?: RelayOptions,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Start the relay. Begins polling outbox tables across all tenant schemas.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.schedulePoll();
  }

  /**
   * Stop the relay gracefully. Waits for the current poll cycle to complete.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Wait for current poll to finish
    if (this.currentPoll) {
      await this.currentPoll;
    }
  }

  /**
   * Whether the relay is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single poll cycle manually. Useful for testing.
   */
  async pollOnce(): Promise<PollResult> {
    return this.poll();
  }

  private schedulePoll(): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(async () => {
      this.currentPoll = this.poll()
        .then(() => {})
        .catch(() => {})
        .finally(() => {
          this.currentPoll = null;
          this.schedulePoll();
        });
    }, this.options.pollIntervalMs);
  }

  private async poll(): Promise<PollResult> {
    const result: PollResult = {
      processed: 0,
      failed: 0,
      tenantErrors: [],
    };

    // Discover all tenant schemas
    let schemas: Array<{ schema_name: string }>;
    try {
      schemas = await this.pool.queryPublic<{ schema_name: string }>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name LIKE 'tenant_%'
         ORDER BY schema_name`,
      );
    } catch (err) {
      result.tenantErrors.push({
