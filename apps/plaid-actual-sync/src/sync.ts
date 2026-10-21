/**
 * The sync itself: pull changed transactions from Plaid, map them onto Actual
 * accounts, and import them.
 *
 * Design notes worth keeping in mind when editing this file:
 *
 *  - Actual accounts are matched by NAME, once, and the mapping is cached in
 *    state. We never rename or merge accounts, because a rename would
 *    silently re-point every future transaction at a different budget account.
 *
 *  - All state mutations are saved only after the corresponding Actual import
 *    succeeds. If the import fails we deliberately do NOT advance the cursor,
 *    so the next run retries the same batch rather than skipping it.
 */

import type { Transaction } from "plaid";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import type { PlaidClient } from "./plaid.js";
import { toAccountKind } from "./plaid.js";
import { describePlaidError, needsReauth } from "./errors.js";
import { syncInvestments } from "./investments.js";
import type { ActualClient, ActualTransactionInput } from "./actual.js";
import type { StateStore, ItemState } from "./state.js";

/**
 * Humanises Plaid personal finance category names (e.g. FOOD_AND_DRINK -> Food & Drink).
 */
export function formatCategoryName(raw: string): string {
  return raw
    .toLowerCase()
    .split("_")
    .map((word) => {
      if (word === "and") return "&";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Extracts a candidate category name from Plaid transaction data.
 * Prefers the modern `personal_finance_category.primary`, falling back to legacy `category[0]`.
 */
export function extractCategoryName(txn: Transaction): string | undefined {
  if (txn.personal_finance_category?.primary) {
    return formatCategoryName(txn.personal_finance_category.primary);
  }
  if (txn.category && txn.category.length > 0) {
    return txn.category[0];
  }
  return undefined;
}

/** A Plaid transaction converted into Actual's import format. */
function convertTransaction(txn: Transaction, categoryId?: string): ActualTransactionInput {
  // Plaid: positive = money leaving the account.
  // Actual: negative = spending.
  // Failing to negate here turns every expense into income.
  const amount = -txn.amount;

  const notesParts: string[] = [];
  if (txn.merchant_name) notesParts.push(txn.merchant_name);
  if (txn.category?.length) notesParts.push(`[${txn.category.join(", ")}]`);
  if (txn.pending) notesParts.push("(pending)");

  return {
    date: txn.date,
    amount,
    payee_name: txn.merchant_name ?? txn.name,
    // The bank's own name for the transaction, preserved so the budget shows
    // what the bank said rather than only our normalised payee.
    imported_payee: txn.name,
    category: categoryId,
    notes: notesParts.join(" ") || undefined,
    // Anything sourced from a bank feed is, by definition, already posted to
    // the bank statement, so it reconciles cleanly.
    cleared: !txn.pending,
    // The dedupe key. Actual recognises a transaction it has already seen by
    // this, which is a backstop behind our own `seen` set.
    imported_id: toImportedId(txn.transaction_id),
  };
}

/**
 * Namespace for Plaid-sourced `imported_id`s.
 *
 * Prefixing keeps a bank-provided ID from colliding with an ID Actual
 * generates itself, and makes our synthetic rows identifiable later.
 */
function toImportedId(plaidTransactionId: string): string {
  return `plaid:${plaidTransactionId}`;
}

/** Resolves (creating if needed) the Actual account backing a Plaid account. */
async function ensureActualAccount(
  plaidAccountName: string,
  cachedId: string | undefined,
  actual: ActualClient,
): Promise<string> {
  if (cachedId) return cachedId;

  const existing = await actual.getAccounts();
  const match = existing.find((a) => a.name === plaidAccountName);
  if (match) {
    log.info("Matched Actual account %s (existing)", match.name);
    return match.id;
  }

  return actual.createAccount(plaidAccountName);
}

/**
 * Deletes Actual transactions that Plaid has removed.
 *
 * Plaid reports a removal when a pending transaction is dropped or a posted
 * one is reversed at the bank. Without this, those rows linger in Actual
 * forever as "ghost" transactions that no longer exist in the bank feed.
 *
 * Resolution is by `imported_id`: Plaid gives us its transaction ID, and the
 * matching Actual row is found by the ID we stamped on import.
 *
 * CAVEAT — this deletes user data. If someone has categorised, annotated or
 * reconciled one of these transactions in Actual, that work is destroyed. Set
 * `DELETE_REMOVED_TRANSACTIONS=false` to downgrade this to a log-only warning.
 */
async function handleRemovals(
  actual: ActualClient,
  removed: Array<{ transaction_id: string }>,
  actualIdByPlaidAccount: Map<string, string>,
  label: string,
  deleteEnabled: boolean,
): Promise<number> {
  let deleted = 0;

  for (const entry of removed) {
    const importedId = toImportedId(entry.transaction_id);

    // Removed entries do not carry an account_id, so search every mapped
    // account. This is a date-ranged query per account, which is acceptable
    // because removals are rare.
    let found: { id: string } | undefined;
    let foundIn: string | undefined;
    for (const actualAccountId of new Set(actualIdByPlaidAccount.values())) {
      found = await actual.findTransactionByImportedId(actualAccountId, importedId);
      if (found) {
        foundIn = actualAccountId;
        break;
      }
    }

    if (!found) continue;

    if (!deleteEnabled) {
      log.warn(
        "%s: Plaid removed %s (Actual tx %s) but DELETE_REMOVED_TRANSACTIONS is false; " +
          "leaving it in the budget.",
        label,
        entry.transaction_id,
        found.id,
      );
      continue;
    }

    await actual.deleteTransaction(found.id);
    deleted++;
    log.info("%s: deleted ghost transaction %s (Actual %s)", label, entry.transaction_id, foundIn);
  }

  if (deleted > 0) {
    log.info("%s: removed %d ghost transaction(s) from Actual.", label, deleted);
  }
  return deleted;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SyncSummary {
  imported: number;
  skippedDuplicates: number;
  failures: string[];
}

/** Per-item result, before failures are aggregated across items. */
interface ItemSyncResult {
  imported: number;
  skippedDuplicates: number;
}

export async function runSync(
  config: Config,
  plaid: PlaidClient,
  actual: ActualClient,
  store: StateStore,
): Promise<SyncSummary> {
  const items = store.listLinkedItems();
  if (items.length === 0) {
    log.warn(
      "No linked Plaid items found. Run `npm run link` once to connect a bank account.",
    );
    return { imported: 0, skippedDuplicates: 0, failures: [] };
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const failures: string[] = [];

  for (const [itemId, item] of items) {
    const label = item.label ?? itemId;
    const token = item.accessToken;
    if (!token) continue;

    // An Item already flagged for re-auth is skipped until a human rotates its
    // token. Retrying it every cycle would just produce the same
    // ITEM_LOGIN_REQUIRED error and bury the real signal in the logs.
    if (item.needsReauth) {
      log.warn("%s is awaiting re-authentication; skipping.", label);
      continue;
    }

    // One item failing must not stop the others, otherwise a single revoked
    // bank link would freeze every other account's sync. Failures are counted
    // and surfaced at the end instead of thrown.
    try {
      const { imported, skippedDuplicates } = await syncItem(
        config,
        plaid,
        actual,
        store,
        itemId,
        item,
        token,
        label,
      );
      totalImported += imported;
      totalSkipped += skippedDuplicates;
    } catch (err) {
      if (needsReauth(err)) {
        // Flag it and stop retrying. The update-mode page will pick this up.
        store.markNeedsReauth(itemId);
        await store.save();
        log.error(
          "%s needs re-authentication (Plaid OAuth grant expired). " +
            "Re-link it from the plaid-sync status page.",
          label,
        );
      } else {
        log.error("Sync failed for %s: %s", label, describePlaidError(err));
      }
      failures.push(label);
    }
  }

  if (failures.length > 0) {
    log.warn("%d item(s) failed this run: %s", failures.length, failures.join(", "));
  }

  const summary = { imported: totalImported, skippedDuplicates: totalSkipped, failures };
  store.setLastSync(summary);
  await store.save();

  return summary;
}

async function syncItem(
  config: Config,
  plaid: PlaidClient,
  actual: ActualClient,
  store: StateStore,
  itemId: string,
  item: ItemState,
  accessToken: string,
  label: string,
): Promise<ItemSyncResult> {

  // Ensure a target Actual account exists for every Plaid account, and cache
  // the mapping so future runs skip the lookup entirely.
  const plaidAccounts = await plaid.listAccounts(accessToken);
  const actualIdByPlaidAccount = new Map<string, string>();
  const investmentAccountIds = new Set<string>();

  for (const pa of plaidAccounts) {
    const displayName = pa.official_name ?? pa.name;
    const kind = toAccountKind(pa.type);
    item.accountKinds[pa.account_id] = kind;
    if (kind === "investment") investmentAccountIds.add(pa.account_id);

    const cached = item.accountMap[pa.account_id];
    const actualId = await ensureActualAccount(displayName, cached, actual);
    item.accountMap[pa.account_id] = actualId;
    actualIdByPlaidAccount.set(pa.account_id, actualId);
  }
  await store.save();

  // ---- Investment accounts use a completely different API surface -------
  // /investments/* is date-ranged with no cursor, so it is handled separately
  // from the transactional path below and never touches the sync cursor.
  let investmentImported = 0;
  if (investmentAccountIds.size > 0) {
    try {
      const result = await syncInvestments(
        plaid,
        actual,
        accessToken,
        label,
        item.accountMap,
        config.sync.investmentWindowDays,
      );
      log.info(
        "%s: investments — %d cash-flow transaction(s), %d balance adjustment(s)",
        label,
        result.transactionsImported,
        result.adjustmentsApplied,
      );
      investmentImported = result.transactionsImported;
    } catch (invErr) {
      log.warn("%s: investment sync skipped (%s)", label, describePlaidError(invErr));
    }
  }

  const hasTransactionalAccounts = plaidAccounts.some((pa) => {
    const kind = toAccountKind(pa.type);
    return kind === "depository" || kind === "credit";
  });

  if (!hasTransactionalAccounts) {
    return { imported: investmentImported, skippedDuplicates: 0 };
  }

  let batch: Transaction[];

  if (!item.cursor) {
    // First run for this item. Backfill a bounded window FIRST, then capture a
    // cursor. Doing it in this order means any transaction that commits
    // during the backfill is still covered by the backfill's date range
    // rather than being lost in the gap.
    const end = new Date();
    const start = new Date(end.getTime() - config.sync.initialSyncDays * 24 * 60 * 60 * 1000);
    log.info(
      "Initial sync for %s: backfilling %s..%s",
      label,
      ymd(start),
      ymd(end),
    );
    batch = await plaid.transactionsInRange(accessToken, ymd(start), ymd(end));

    // Capture-and-discard the cursor so subsequent runs are incremental.
    const cursorOnly = await plaid.transactionsSync(accessToken, undefined);
    item.cursor = cursorOnly.nextCursor;
  } else {
    const delta = await plaid.transactionsSync(accessToken, item.cursor);
    batch = [...delta.added, ...delta.modified];

    if (delta.removed.length > 0) {
      await handleRemovals(actual, delta.removed, actualIdByPlaidAccount, label, config.sync.deleteRemoved);
    }
  }

  // Dedupe. Plaid re-sends transactions when they are mutated, and the
  // backfill path can overlap with a subsequent sync's first batch.
  const fresh = batch.filter((t) => !store.hasSeen(itemId, t.transaction_id));

  const skipped = batch.length - fresh.length;

  // Group by target account; Actual imports per-account, not in bulk.
  const grouped = new Map<string, ActualTransactionInput[]>();
  for (const txn of fresh) {
    const target = actualIdByPlaidAccount.get(txn.account_id);
    // Transactions on a Plaid account we could not map are skipped rather
    // than dumped into an arbitrary account.
    if (!target) {
      log.warn("%s: no Actual account for Plaid account %s; skipping %s", label, txn.account_id, txn.transaction_id);
      continue;
    }

    let categoryId: string | undefined;
    if (config.sync.autoCategorize) {
      const categoryName = extractCategoryName(txn);
      if (categoryName) {
        try {
          categoryId = await actual.ensureCategory(categoryName, config.sync.categoryGroupName);
        } catch (catErr) {
          log.warn("%s: failed to resolve category \"%s\": %s", label, categoryName, (catErr as Error).message);
        }
      }
    }

    const list = grouped.get(target) ?? [];
    list.push(convertTransaction(txn, categoryId));
    grouped.set(target, list);
  }

  for (const [accountId, transactions] of grouped) {
    await actual.importTransactions(accountId, transactions);
  }

  store.markSeen(
    itemId,
    fresh.map((t) => t.transaction_id),
  );
  await store.save();

  log.info("%s: imported %d, skipped %d duplicate(s)", label, fresh.length + investmentImported, skipped);
  return { imported: fresh.length + investmentImported, skippedDuplicates: skipped };
}