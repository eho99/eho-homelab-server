/**
 * Plaid-only inspection.
 *
 * This is the answer to "is my bank link actually working?" — you can link an
 * institution and look at exactly what Plaid returns BEFORE any of it reaches
 * Actual. That matters because the two systems fail in completely different
 * ways: a bad Plaid link and a bad Actual budget produce confusingly similar
 * "no transactions appeared" symptoms otherwise.
 *
 * TWO INVARIANTS, both important:
 *
 *  1. This module NEVER touches Actual. Not "usually doesn't" — cannot. It
 *     takes no ActualClient and has no way to reach one.
 *
 *  2. This module NEVER advances the sync cursor. It reads via
 *     `/transactions/get` (date-ranged) rather than `/transactions/sync`
 *     (cursor-based). If previewing mutated the cursor, opening the dashboard
 *     would silently swallow transactions that the real sync would then never
 *     see. Reading must not have side effects on sync state.
 */

import type { Config } from "./config.js";
import { log } from "./logger.js";
import type { PlaidClient } from "./plaid.js";
import type { StateStore } from "./state.js";
import { classifyPlaidError, describePlaidError, plaidErrorCode } from "./errors.js";
import { toAccountKind } from "./plaid.js";

/** A transaction as shown in the dashboard preview. */
export interface PreviewTransaction {
  transactionId: string;
  accountId: string;
  accountName: string;
  date: string;
  /** Plaid's raw amount: positive means money LEFT the account. */
  amount: number;
  name: string;
  merchantName: string | null;
  pending: boolean;
  category: string[];
}

export interface PreviewAccount {
  accountId: string;
  name: string;
  mask: string | null;
  kind: string;
  /** Current balance for depository/credit accounts, when Plaid provides it. */
  balance: number | null;
  subtype: string | null;
}

export interface PreviewItemResult {
  itemKey: string;
  label: string;
  needsReauth: boolean;
  accounts: PreviewAccount[];
  transactions: PreviewTransaction[];
  /** Holdings snapshot for investment items. */
  investments: Array<{ name: string; current: number; available: number | null }> | null;
  /** Populated when this item could not be read. */
  error: string | null;
  /** True when Plaid is still loading initial history. */
  stillLoading: boolean;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Reads recent data for every linked item, without side effects.
 *
 * `days` bounds the window. Plaid's `/transactions/get` has no cursor, so this
 * is a straight date-range read each time.
 */
export async function buildPreview(
  config: Config,
  plaid: PlaidClient,
  store: StateStore,
  days: number,
): Promise<PreviewItemResult[]> {
  const items = store.listLinkedItems();

  const results = await Promise.all(
    items.map(async ([itemKey, item]): Promise<PreviewItemResult> => {
      const label = item.label ?? itemKey;
      const base: PreviewItemResult = {
        itemKey,
        label,
        needsReauth: item.needsReauth === true,
        accounts: [],
        transactions: [],
        investments: null,
        error: null,
        stillLoading: false,
      };

      const accessToken = item.accessToken;
      if (!accessToken) return base;

      try {
        const accounts = await plaid.listAccounts(accessToken);

        base.accounts = accounts.map((a) => ({
          accountId: a.account_id,
          name: a.official_name ?? a.name,
          mask: a.mask ?? null,
          kind: toAccountKind(a.type),
          balance: a.balances?.current ?? null,
          subtype: a.subtype ?? null,
        }));

        const hasTransactional = accounts.some((a) => {
          const kind = toAccountKind(a.type);
          return kind === "depository" || kind === "credit";
        });
        const hasInvestment = accounts.some((a) => toAccountKind(a.type) === "investment");

        if (hasInvestment) {
          try {
            const snapshot = await plaid.investmentHoldings(accessToken);
            base.investments = snapshot.accounts.map((a) => ({
              name: a.name,
              current: a.current,
              available: a.available,
            }));
          } catch (invErr) {
            log.warn("Could not read investment holdings for %s: %s", label, describePlaidError(invErr));
          }
        }

        if (hasTransactional) {
          const end = new Date();
          const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
          const txns = await plaid.transactionsInRange(accessToken, ymd(start), ymd(end));

          const nameByAccount = new Map(base.accounts.map((a) => [a.accountId, a.name]));

          base.transactions = txns
            .map(
              (t): PreviewTransaction => ({
                transactionId: t.transaction_id,
                accountId: t.account_id,
                accountName: nameByAccount.get(t.account_id) ?? t.account_id,
                date: t.date,
                // Shown RAW and un-negated on purpose. This preview's job is to
                // show what Plaid actually returned; the sign flip that Actual
                // needs happens during import, and seeing the raw value here is
                // how you diagnose an inverted-amount bug.
                amount: t.amount,
                name: t.name,
                merchantName: t.merchant_name ?? null,
                pending: t.pending,
                category: t.category ?? [],
              }),
            )
            // Most recent first — what you actually want to look at.
            .sort((a, b) => b.date.localeCompare(a.date));
        }

        return base;
      } catch (err) {
        // PRODUCT_NOT_READY is the normal state right after linking, not a
        // failure. Reporting it as an error makes a healthy link look broken.
        if (plaidErrorCode(err) === "PRODUCT_NOT_READY") {
          base.stillLoading = true;
          base.error =
            "Plaid is still downloading this institution's history. " +
            "This usually resolves within a few minutes — reload.";
          return base;
        }

        if (classifyPlaidError(err) === "reauth") {
          base.needsReauth = true;
          base.error = "This connection has expired and needs re-authentication.";
          return base;
        }

        base.error = describePlaidError(err);
        log.warn("Preview failed for %s: %s", label, base.error);
        return base;
      }
    }),
  );

  return results;
}