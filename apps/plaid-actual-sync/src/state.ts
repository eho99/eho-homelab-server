/**
 * Persistent sync state.
 *
 * Holds three things per Plaid Item:
 *   - the `transactionsSync` cursor (so restarts resume instead of replaying)
 *   - a set of already-imported Plaid transaction IDs (dedupe)
 *   - the Plaid Account -> Actual Account mapping (stable across syncs)
 *
 * This file is the one piece of state the worker cannot rebuild from scratch,
 * so it lives on the persistent `/data` volume.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";

const STATE_VERSION = 1;

/** How long an imported-transaction ID is remembered before being pruned. */
const SEEN_TTL_DAYS = 90;
const SEEN_TTL_MS = SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface ItemState {
  /**
   * The durable Plaid access token, obtained once at link time. It never
   * expires and grants full read access to the linked bank account, so this
   * file is secret material — it lives on the gitignored `/data` volume and
   * nothing else may be written to it.
   */
  accessToken?: string;
  /** Human label shown in logs, e.g. the institution name. */
  label?: string;
  cursor?: string;
  /**
   * Set when Plaid reports ITEM_LOGIN_REQUIRED. The worker skips this Item
   * until the update-mode UI rotates its token, rather than retrying a call
   * that is guaranteed to fail on every cycle.
   */
  needsReauth?: boolean;
  /** ISO timestamp of when re-auth was first requested, for operator triage. */
  reauthSince?: string;
  /** Plaid account_id -> "depository" | "credit" | "investment" | "other". */
  accountKinds: Record<string, AccountKind>;
  /** Plaid transaction ID -> epoch ms at which we first imported it. */
  seen: Record<string, number>;
  /** Plaid Account ID -> Actual Account ID. */
  accountMap: Record<string, string>;
}

export interface State {
  version: number;
  items: Record<string, ItemState>;
}

/**
 * How we treat a Plaid account. Investment accounts follow a completely
 * different Plaid API surface (/investments/*) than transactional ones
 * (/transactions/sync), so the kind is recorded once at link time and drives
 * routing for the life of the link.
 */
export type AccountKind = "depository" | "credit" | "investment" | "other";

function emptyItem(): ItemState {
  return { seen: {}, accountMap: {}, accountKinds: {} };
}

function emptyState(): State {
  return { version: STATE_VERSION, items: {} };
}

export class StateStore {
  private readonly dataDir: string;
  private readonly path: string;
  private state: State = emptyState();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.path = join(dataDir, "state.json");
  }

  /**
   * Reads state from disk. A missing file is the normal first-run case, but a
   * corrupt one is treated as fatal rather than silently discarded — wiping
   * dedupe data would re-import every transaction Plaid still retains.
   */
  async load(): Promise<void> {
    // Create the directory up front. A bind-mounted volume or a fresh
    // container both start empty, and `save()` would otherwise fail on the
    // very first write.
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as State;
      if (parsed.version !== STATE_VERSION) {
        throw new Error(`unsupported state version ${parsed.version}`);
      }
      this.state = parsed;
      log.info(
        "Loaded sync state for %d item(s) from %s",
        Object.keys(parsed.items).length,
        this.path,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
        log.info("No existing sync state; starting fresh.");
        return;
      }
      throw new Error(
        `Failed to read sync state at ${this.path}: ${(err as Error).message}. ` +
          `Move the file aside to force a full re-sync.`,
      );
    }
  }

  /**
   * Writes state atomically: a crash mid-write leaves the previous good file
   * intact rather than a truncated JSON document that would fail to parse on
   * the next boot.
   */
  async save(): Promise<void> {
    this.pruneSeen();
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tmp, this.path);
  }

  getItem(itemId: string): ItemState {
    const existing = this.state.items[itemId];
    if (existing) return existing;
    const fresh = emptyItem();
    this.state.items[itemId] = fresh;
    return fresh;
  }

  /**
   * Every Item that has completed the link step, as `[stateKey, state]`
   * pairs. The key is passed back to the caller so it can scope dedupe and
   * cursor updates without having to reverse an identity lookup later.
   */
  listLinkedItems(): Array<[string, ItemState]> {
    return Object.entries(this.state.items).filter(
      (entry): entry is [string, ItemState] => entry[1].accessToken !== undefined,
    );
  }

  /**
   * Records a newly linked item and returns its internal ID.
   *
   * Items are keyed by the access token's own identity because Plaid returns
   * `item_id` from `itemPublicTokenExchange`, but we deliberately key on a
   * locally generated ID so the raw token never appears as a JSON key.
   */
  addItem(accessToken: string, itemId: string, label: string): string {
    const localId = `item-${Object.keys(this.state.items).length + 1}-${itemId.slice(0, 8)}`;
    this.state.items[localId] = {
      ...emptyItem(),
      accessToken,
      label,
    };
    return localId;
  }

  /** Removes an Item from the state file completely. */
  removeItem(localId: string): boolean {
    if (this.state.items[localId]) {
      delete this.state.items[localId];
      return true;
    }
    return false;
  }

  /** Flags an Item as needing a human to re-link it. */
  markNeedsReauth(itemId: string): void {
    const item = this.getItem(itemId);
    item.needsReauth = true;
    item.reauthSince ??= new Date().toISOString();
  }

  /**
   * Clears the re-auth flag after a successful update-mode exchange.
   *
   * The `cursor` is deliberately preserved: it tracks position within the
   * institution's transaction history, not the token, so the rotated token
   * continues from exactly where the old one stopped.
   */
  clearNeedsReauth(itemId: string): void {
    const item = this.getItem(itemId);
    item.needsReauth = false;
    delete item.reauthSince;
  }

  /** Items currently awaiting a human, for display on the status page. */
  listNeedingReauth(): Array<[string, ItemState]> {
    return Object.entries(this.state.items).filter(([, item]) => item.needsReauth === true);
  }

  hasSeen(itemId: string, transactionId: string): boolean {
    return transactionId in this.getItem(itemId).seen;
  }

  markSeen(itemId: string, transactionIds: string[]): void {
    const item = this.getItem(itemId);
    const now = Date.now();
    for (const id of transactionIds) {
      // First write wins, so an ID keeps its original timestamp and expires
      // a fixed TTL after it was actually imported.
      item.seen[id] ??= now;
    }
  }

  getCursor(itemId: string): string | undefined {
    return this.getItem(itemId).cursor;
  }

  setCursor(itemId: string, cursor: string): void {
    this.getItem(itemId).cursor = cursor;
  }

  private pruneSeen(): void {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const item of Object.values(this.state.items)) {
      for (const [id, ts] of Object.entries(item.seen)) {
        if (ts < cutoff) delete item.seen[id];
      }
    }
  }
}