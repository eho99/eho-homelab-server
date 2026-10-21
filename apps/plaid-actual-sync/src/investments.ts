/**
 * Investment account syncing (Schwab, Fidelity, and any brokerage Plaid
 * classifies as `investment`).
 *
 * Investments need a fundamentally different approach from /transactions/sync:
 *
 *  1. `/investments/transactions/get` is DATE-RANGED, not cursor-based. There
 *     is no incremental sync for investments in Plaid, so every cycle re-reads
 *     a rolling window and relies on `imported_id` for idempotency.
 *
 *  2. `/investments/holdings/get` is a point-in-time snapshot with no cursor
 *     at all.
 *
 *  3. Actual has NO API for setting an account balance. `createAccount` accepts
 *     an opening balance, but there is nothing to update it afterwards.
 *
 * That last constraint drives the design here. An Actual account's balance is
 * always the sum of its transactions, so to make a brokerage account display
 * its true total value we post a single ADJUSTMENT transaction that makes the
 * sum come out right. Each cycle we delete the previous adjustment and post a
 * fresh one, which keeps the operation idempotent — a repeated sync converges
 * on the same single adjustment rather than accumulating them.
 *
 * Buys and sells are deliberately NOT imported. They move value between cash
 * and securities *within* the account and leave its total unchanged, so
 * importing them would double-count against a value-tracking account. Only
 * genuine cash flows (dividends, interest, fees, taxes, contributions) are
 * imported as transactions.
 */

import type { InvestmentTransaction as PlaidInvestmentTransaction } from "plaid";
import type { ActualClient, ActualTransactionInput } from "./actual.js";
import type { PlaidClient } from "./plaid.js";
import { log } from "./logger.js";

/**
 * Prefixes let us find our own synthetic transactions again later. They are
 * namespaced so a Plaid transaction can never collide with them.
 */
const ADJUSTMENT_PREFIX = "plaid-investment-adjustment:";

/**
 * Investment transaction types that represent real cash entering or leaving
 * the account. `buy` and `sell` are excluded: they reallocate value inside
 * the account without changing its total.
 */
const CASH_FLOW_TYPES = new Set([
  "dividend",
  "interest",
  "bank_fee",
  "tax",
  "contribution",
  "withdrawal",
  "other",
]);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Converts a Plaid investment transaction into Actual's format.
 *
 * Plaid's investment `amount` already carries direction (a buy is negative
 * because cash leaves, a dividend is positive), which is the same convention
 * Actual uses, so the value is passed through without a sign flip. That is the
 * opposite of `/transactions/sync`, where a positive means money left.
 *
 * Returns undefined for types we intentionally skip.
 */
function convertInvestmentTransaction(
  txn: PlaidInvestmentTransaction,
): ActualTransactionInput | undefined {
  const type = String(txn.type).toLowerCase();
  if (!CASH_FLOW_TYPES.has(type)) return undefined;

  const subtype = txn.subtype ? ` (${txn.subtype})` : "";
  return {
    date: txn.date,
    amount: txn.amount,
    payee_name: `${txn.name}${subtype}`,
    // The stable Plaid ID is what makes re-reading the same window safe.
    imported_id: `plaid-investment:${txn.investment_transaction_id}`,
    cleared: true,
    notes: `Plaid investment transaction (${type})`,
  };
}

export interface InvestmentSyncResult {
  transactionsImported: number;
  adjustmentsApplied: number;
}

/**
 * Syncs investment accounts: real cash flows as transactions, then a balance
 * adjustment so each account reports its true total value.
 */
export async function syncInvestments(
  plaid: PlaidClient,
  actual: ActualClient,
  accessToken: string,
  label: string,
  accountMap: Record<string, string>,
  windowDays: number,
): Promise<InvestmentSyncResult> {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [snapshots, investmentTxns] = await Promise.all([
    plaid.investmentHoldings(accessToken),
    plaid.investmentTransactions(accessToken, ymd(start), ymd(end)),
  ]);

  // ---- Cash-flow transactions, grouped by destination account ------------
  const grouped = new Map<string, ActualTransactionInput[]>();
  for (const txn of investmentTxns) {
    const target = accountMap[txn.account_id];
    if (!target) {
      log.warn(
        "%s: no Actual account for investment account %s; skipping %s",
        label,
        txn.account_id,
        txn.investment_transaction_id,
      );
      continue;
    }
    const converted = convertInvestmentTransaction(txn);
    if (!converted) continue;

    const list = grouped.get(target) ?? [];
    list.push(converted);
    grouped.set(target, list);
  }

  let transactionsImported = 0;
  for (const [accountId, txns] of grouped) {
    await actual.importTransactions(accountId, txns);
    transactionsImported += txns.length;
  }

  // ---- Balance adjustment ------------------------------------------------
  let adjustmentsApplied = 0;
  for (const snapshot of snapshots.accounts) {
    const actualAccountId = accountMap[snapshot.accountId];
    if (!actualAccountId) continue;
    if (await reconcileAccountBalance(actual, actualAccountId, snapshot.current, label)) {
      adjustmentsApplied++;
    }
  }

  return { transactionsImported, adjustmentsApplied };
}

/**
 * Makes one Actual account's computed balance equal `target` by rewriting or
 * updating a single adjustment transaction. Returns true if an adjustment was posted/updated.
 */
async function reconcileAccountBalance(
  actual: ActualClient,
  actualAccountId: string,
  target: number,
  label: string,
): Promise<boolean> {
  const allTxns = await actual.getAllTransactions(actualAccountId);

  let baseBalance = 0;
  let existingAdjustment: { id: string; amount: number } | undefined;

  for (const t of allTxns) {
    if (t.importedId && t.importedId.startsWith(ADJUSTMENT_PREFIX)) {
      if (!existingAdjustment) {
        existingAdjustment = { id: t.id, amount: t.amount };
      } else {
        // Redundant extra adjustments if any existed in the past
        await actual.deleteTransaction(t.id);
      }
    } else {
      baseBalance += t.amount;
    }
  }

  // Rounding to 2 decimal places to avoid floating-point drift
  const neededAdjustment = Math.round((target - baseBalance) * 100) / 100;

  if (existingAdjustment) {
    const diff = Math.abs(existingAdjustment.amount - neededAdjustment);
    if (diff < 0.01) {
      return false; // Already matches perfectly
    }

    log.info(
      "%s: updating investment adjustment in account %s (old: %.2f -> new: %.2f) to reach target %.2f",
      label,
      actualAccountId,
      existingAdjustment.amount,
      neededAdjustment,
      target,
    );

    await actual.updateTransaction(existingAdjustment.id, {
      amount: neededAdjustment,
      date: ymd(new Date()),
    });
    return true;
  }

  // If no adjustment exists yet and neededAdjustment is not 0
  if (Math.abs(neededAdjustment) < 0.01) {
    return false;
  }

  log.info(
    "%s: creating initial investment adjustment in account %s of %.2f to reach target %.2f",
    label,
    actualAccountId,
    neededAdjustment,
    target,
  );

  await actual.importTransactions(actualAccountId, [
    {
      date: ymd(new Date()),
      amount: neededAdjustment,
      payee_name: "Investment balance adjustment",
      imported_id: `${ADJUSTMENT_PREFIX}${actualAccountId}`,
      cleared: true,
      notes: "Auto-generated to match the brokerage balance reported by Plaid.",
    },
  ]);

  return true;
}