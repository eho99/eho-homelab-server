/**
 * Wrapper around Actual Budget's official Node client (`@actual-app/api`).
 *
 * Worth knowing before reading further: Actual does NOT expose a REST API.
 * The client downloads a full local copy of the budget file into `dataDir`,
 * runs the real budgeting engine against that local SQLite copy, and syncs
 * with the server. So `dataDir` must be a persistent volume or every restart
 * re-downloads the entire budget.
 */

import * as actualApi from "@actual-app/api";
import { log } from "./logger.js";
import type { Config } from "./config.js";

/** The subset of an Actual account this worker cares about. */
export interface ActualAccount {
  id: string;
  name: string;
  type: string;
  offbudget: boolean;
}

/**
 * A transaction in the shape `importTransactions` expects, with `amount` still
 * as a normal decimal value (e.g. -12.34).
 *
 * NOTE on the sign convention: Plaid reports positive amounts for money
 * leaving the account, while Actual's internal convention is negative for
 * spending. The negation in `convertTransaction` is what bridges the two —
 * getting this backwards turns your expenses into income.
 *
 * NOTE on precision: Actual stores amounts as integer cents. This type keeps
 * the value as a float and `importTransactions` below converts it, so the
 * rounding happens in exactly one place.
 *
 * `imported_id` is the crux of deduplication: it is where Plaid's
 * `transaction_id` is stored, and Actual recognises transactions by it.
 * Populating it means a replayed sync cannot double-post, even if this
 * project's own state file is lost.
 */
export interface ActualTransactionInput {
  date: string;
  amount: number;
  payee_name?: string;
  imported_payee?: string;
  category?: string;
  notes?: string;
  cleared?: boolean;
  imported_id?: string;
}

/**
 * Default lower bound for `findTransactionByImportedId`. Ten years back is
 * wide enough for any realistic bank feed and keeps the date-ranged query
 * from returning an unbounded transaction list.
 */
function defaultSearchStart(): string {
  return ymd(new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000));
}

/** Tomorrow, so a transaction dated today is always inside the range. */
function futureDate(): string {
  return ymd(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class ActualClient {
  private connected = false;

  constructor(private readonly config: Config) {}

  async connect(): Promise<void> {
    // Guard rather than a null dereference: calling this while Actual is
    // unconfigured should say why, not fail with something opaque.
    if (!this.config.actual.enabled) {
      throw new Error(
        "Actual Budget is not configured (ACTUAL_URL / ACTUAL_PASSWORD / " +
          "ACTUAL_BUDGET_ID). Set all three to enable syncing.",
      );
    }

    log.info("Connecting to Actual at %s", this.config.actual.url);
    await actualApi.init({
      dataDir: this.config.dataDir,
      serverURL: this.config.actual.url!,
      password: this.config.actual.password!,
    });

    const e2e = this.config.actual.e2ePassword;
    try {
      await actualApi.downloadBudget(
        this.config.actual.budgetId!,
        e2e ? { password: e2e } : undefined,
      );
    } catch (err) {
      // The API attaches stable machine-readable codes to connection failures,
      // which is much more reliable than matching on message text.
      const code = (err as { code?: string }).code;
      if (code) {
        throw new Error(`Could not download Actual budget (${code}): ${(err as Error).message}`);
      }
      throw err;
    }

    this.connected = true;
    log.info("Downloaded Actual budget %s", this.config.actual.budgetId);
  }

  async shutdown(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await actualApi.shutdown();
    } catch (err) {
      log.warn("Error during Actual shutdown: %s", (err as Error).message);
    }
  }

  private categoryCache = new Map<string, string>();
  private categoryGroupId?: string;

  async getAccounts(): Promise<ActualAccount[]> {
    const accounts = (await actualApi.getAccounts()) as unknown as ActualAccount[];
    return accounts.filter((a) => !a.name.startsWith("Deleted account"));
  }

  async createAccount(name: string): Promise<string> {
    const id = await actualApi.createAccount({ name, offbudget: false });
    log.info("Created Actual account %s (%s)", name, id);
    return id;
  }

  /**
   * Resolves an Actual category ID for a given category name.
   *
   * 1. Checks memory cache.
   * 2. Checks all existing categories in Actual (case-insensitive match).
   * 3. If missing, ensures target category group exists, then creates the category.
   */
  async ensureCategory(categoryName: string, groupName = "Plaid"): Promise<string> {
    const normalizedKey = categoryName.trim().toLowerCase();
    const cached = this.categoryCache.get(normalizedKey);
    if (cached) return cached;

    const existingCategories = (await actualApi.getCategories()) as Array<{
      id: string;
      name: string;
      is_income?: boolean;
    }>;

    const matched = existingCategories.find(
      (c) => c.name.trim().toLowerCase() === normalizedKey && !c.is_income,
    );
    if (matched) {
      this.categoryCache.set(normalizedKey, matched.id);
      return matched.id;
    }

    // Ensure group exists
    let groupId = this.categoryGroupId;
    if (!groupId) {
      const groups = (await actualApi.getCategoryGroups()) as Array<{
        id: string;
        name: string;
        is_income?: boolean;
      }>;
      const groupMatch = groups.find(
        (g) => g.name.trim().toLowerCase() === groupName.trim().toLowerCase() && !g.is_income,
      );
      if (groupMatch) {
        groupId = groupMatch.id;
      } else {
        groupId = await actualApi.createCategoryGroup({ name: groupName });
        log.info("Created Actual category group \"%s\" (%s)", groupName, groupId);
      }
      this.categoryGroupId = groupId;
    }

    const createdId = await actualApi.createCategory({
      name: categoryName,
      group_id: groupId,
    });
    log.info("Created Actual category \"%s\" in group \"%s\" (%s)", categoryName, groupName, createdId);

    this.categoryCache.set(normalizedKey, createdId);
    return createdId;
  }

  /**
   * Imports a batch of transactions into one account.
   *
   * This uses `importTransactions` rather than `addTransactions` on purpose:
   * `addTransactions` is for bulk file imports — it skips reconciliation and
   * does not create the other half of transfer pairs. We want the
   * reconciling, dedupe-aware path because we are appending to an existing
   * budget on a recurring schedule.
   *
   * Two mechanical details handled here so callers cannot get them wrong:
   * the `account` field is required on every entity despite already being
   * passed as `accountId`, and amounts must be integer cents.
   */
  async importTransactions(
    accountId: string,
    transactions: ActualTransactionInput[],
  ): Promise<void> {
    if (transactions.length === 0) return;

    const entities = transactions.map((t) => ({
      account: accountId,
      date: t.date,
      amount: actualApi.utils.amountToInteger(t.amount),
      payee_name: t.payee_name,
      imported_payee: t.imported_payee,
      category: t.category,
      notes: t.notes,
      cleared: t.cleared,
      imported_id: t.imported_id,
    }));

    const result = await actualApi.importTransactions(accountId, entities);

    // importTransactions reports per-row problems in an `errors` array rather
    // than by rejecting, so a partially-failed batch must be surfaced or it
    // looks like a clean success in the logs.
    if (result.errors?.length) {
      log.warn(
        "Actual reported %d error(s) importing into %s: %s",
        result.errors.length,
        accountId,
        result.errors.map((e) => e.message).join("; "),
      );
    }

    log.info("Imported %d transaction(s) into Actual account %s", transactions.length, accountId);
  }

  /**
   * Finds an Actual transaction by the `imported_id` we stamped on it.
   *
   * This is how Plaid IDs are resolved to Actual IDs, which both the removal
   * path and the investment-balance adjustment depend on.
   *
   * `getTransactions` is date-ranged, so `searchFrom` must be early enough to
   * cover the transaction being looked for. Ten years is a deliberately
   * generous default for a bank feed.
   */
  async findTransactionByImportedId(
    accountId: string,
    importedId: string,
    searchFrom = defaultSearchStart(),
  ): Promise<{ id: string; amount: number } | undefined> {
    const transactions = await actualApi.getTransactions(
      accountId,
      searchFrom,
      futureDate(),
    );

    const match = (transactions as unknown as Array<{ id: string; amount: number; imported_id: string | null }>)
      .find((t) => t.imported_id === importedId);

    return match ? { id: match.id, amount: match.amount } : undefined;
  }

  async deleteTransaction(transactionId: string): Promise<void> {
    await actualApi.deleteTransaction(transactionId);
    log.info("Deleted Actual transaction %s", transactionId);
  }

  /** Current computed balance, in decimal units (e.g. -1234.56). */
  async getAccountBalance(accountId: string): Promise<number> {
    const cents = await actualApi.getAccountBalance(accountId);
    return actualApi.utils.integerToAmount(cents);
  }

  /**
   * Every transaction in an account that carries an `imported_id`, with the
   * amount converted back to decimal units.
   *
   * Used to locate the synthetic balance-adjustment transactions this project
   * created, which are identified purely by their `imported_id` prefix.
   */
  async getTransactionsWithImportedIds(
    accountId: string,
    searchFrom = defaultSearchStart(),
  ): Promise<Array<{ id: string; importedId: string; amount: number }>> {
    const transactions = await actualApi.getTransactions(accountId, searchFrom, futureDate());

    return (
      transactions as unknown as Array<{ id: string; amount: number; imported_id: string | null }>
    ).map((t) => ({
      id: t.id,
      importedId: t.imported_id ?? "",
      amount: actualApi.utils.integerToAmount(t.amount),
    }));
  }
}