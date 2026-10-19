/**
 * Serialises and coalesces sync runs.
 *
 * Two independent things want to trigger syncs: the interval timer and
 * incoming webhooks. If each just called `runSync` directly they would
 * happily run concurrently against the same Actual connection and the same
 * Plaid cursors, which is how you get duplicate transactions and corrupt
 * state. This is the single place a sync may actually be started.
 *
 * It also handles the timing asymmetry that makes webhooks awkward:
 *
 *   - Plaid expects a webhook POST answered in ~10 seconds.
 *   - A sync can take minutes (downloading a budget, paging transactions).
 *
 * So the webhook handler enqueues and returns immediately; the work happens
 * afterwards, debounced so that a burst of twenty webhooks from a busy day
 * produces ONE sync rather than twenty.
 */

import type { Config } from "./config.js";
import { log } from "./logger.js";
import { PlaidClient } from "./plaid.js";
import { ActualClient } from "./actual.js";
import { StateStore } from "./state.js";
import { runSync } from "./sync.js";

export type TriggerReason = "timer" | "webhook" | "manual" | "startup";

export interface SyncResult {
  imported: number;
  skippedDuplicates: number;
  failures: string[];
}

/** Resolves once a run that covered the caller's request has finished. */
interface Waiter {
  resolve: (result: SyncResult | null) => void;
}

export class SyncCoordinator {
  private running = false;
  private queued: TriggerReason | null = null;
  private lastRunAt = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private waiters: Waiter[] = [];

  constructor(private readonly config: Config) {}

  /**
   * Requests a sync and resolves with its result.
   *
   * If a run is already in flight the request is queued and this promise
   * resolves after the follow-up run. If it was debounced away it resolves
   * when the deferred run completes. Callers therefore always learn the real
   * outcome rather than a guess.
   */
  request(reason: TriggerReason): Promise<SyncResult | null> {
    const promise = new Promise<SyncResult | null>((resolve) => {
      this.waiters.push({ resolve });
    });

    if (this.running) {
      this.queued = reason;
      log.info("Sync already running; queued a %s-triggered follow-up.", reason);
      return promise;
    }

    if (reason === "webhook" && this.shouldDebounce()) {
      const waitMs = this.config.webhookDebounceSeconds * 1000 - (Date.now() - this.lastRunAt);
      log.info(
        "Webhook coalesced; running in %ds (last sync %ds ago).",
        Math.round(waitMs / 1000),
        Math.round((Date.now() - this.lastRunAt) / 1000),
      );
      this.debouncedRun(waitMs, reason);
      return promise;
    }

    void this.execute(reason);
    return promise;
  }

  /** Fire-and-forget trigger, for callers with no result to report. */
  trigger(reason: TriggerReason): void {
    void this.request(reason);
  }

  private shouldDebounce(): boolean {
    if (this.lastRunAt === 0) return false;
    return Date.now() - this.lastRunAt < this.config.webhookDebounceSeconds * 1000;
  }

  private debouncedRun(delayMs: number, reason: TriggerReason): void {
    // Collapse repeat requests onto the one pending timer.
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.execute(reason);
    }, delayMs);
    // A pending debounce should not by itself keep the process alive.
    this.debounceTimer.unref?.();
  }

  private async execute(reason: TriggerReason): Promise<void> {
    this.running = true;
    let result: SyncResult | null = null;

    try {
      // Fresh clients per cycle: the Actual client caches a full local copy
      // of the budget and must be refreshed from the server each time.
      const plaid = new PlaidClient(this.config);
      const store = new StateStore(this.config.dataDir);
      const actual = new ActualClient(this.config);

      await store.load();
      try {
        if (!this.config.actual.enabled) {
          log.warn("Actual is not configured; skipping %s-triggered sync.", reason);
        } else {
          await actual.connect();
          result = await runSync(this.config, plaid, actual, store);
          log.info(
            "%s-triggered sync: imported %d, skipped %d, %d failure(s).",
            reason,
            result.imported,
            result.skippedDuplicates,
            result.failures.length,
          );
        }
      } finally {
        await actual.shutdown();
      }
    } catch (err) {
      log.error("%s-triggered sync failed: %s", reason, (err as Error).message);
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();

      // Resolve everyone waiting on this pass. A queued request gets its own
      // pass and its waiters were NOT drained here.
      const current = this.waiters;
      this.waiters = [];
      for (const waiter of current) waiter.resolve(result);

      const queued = this.queued;
      if (queued) {
        this.queued = null;
        void this.execute(queued);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}