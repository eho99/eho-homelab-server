/**
 * Thin wrapper over the Plaid API.
 *
 * Only the endpoints this worker actually needs are exposed, so the rest of
 * the code never has to deal with Plaid's response envelope directly.
 */

import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type Holding,
  type InvestmentTransaction as PlaidInvestmentTransaction,
  type Security,
  type Transaction,
} from "plaid";
import type { Config } from "./config.js";
import type { AccountKind } from "./state.js";
import { log } from "./logger.js";
import { describePlaidError, plaidErrorCode } from "./errors.js";

/**
 * Plaid account types are `depository`, `credit`, `investment`, `loan`,
 * `brokerage`, `other`. Anything that is not transactional gets routed away
 * from `/transactions/sync`, which does not cover it.
 */
export function toAccountKind(type: string | null | undefined): AccountKind {
  switch (type) {
    case "depository":
      return "depository";
    case "credit":
      return "credit";
    case "investment":
    case "brokerage":
      return "investment";
    default:
      return "other";
  }
}

/** A batch of transaction deltas returned by /transactions/sync. */
export interface SyncDelta {
  added: Transaction[];
  modified: Transaction[];
  removed: { transaction_id: string }[];
  nextCursor: string;
}

/** Balance snapshot for a single investment account. */
export interface InvestmentAccountBalanceInfo {
  accountId: string;
  name: string;
  /** Total value including uninvested cash. */
  current: number;
  available: number | null;
}

export class PlaidClient {
  private readonly api: PlaidApi;
  private readonly clientName: string;

  constructor(private readonly config: Config) {
    this.clientName = `plaid-actual-sync/0.1.0 (actual: ${config.actual.url})`;

    this.api = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[config.plaid.env],
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": config.plaid.clientId,
            "PLAID-SECRET": config.plaid.secret,
          },
        },
      }),
    );
  }

  /**
   * Lists the accounts attached to an Item.
   *
   * We cannot enumerate Items via `itemsGet` and drive the worker from that:
   * Plaid never returns `access_token` from any endpoint except the initial
   * link exchange. So access tokens must be persisted by `link.ts` at
   * onboarding time, and the sync loop works from those stored tokens.
   */
  async listAccounts(accessToken: string): Promise<AccountBase[]> {
    const response = await this.api.accountsGet({ access_token: accessToken });
    return response.data.accounts ?? [];
  }

  /**
   * Identifies which Plaid Item an access token belongs to, and which
   * institution it is. Only `itemPublicTokenExchange` returns an `item_id`
   * alongside a fresh token, so this is how a stored token is recognised
   * again later.
   */
  async getItem(accessToken: string): Promise<{ itemId: string; institutionName: string }> {
    const response = await this.api.itemGet({ access_token: accessToken });
    const item = response.data.item;
    return {
      itemId: item.item_id,
      institutionName: item.institution_name ?? "linked institution",
    };
  }

  /**
   * Exchanges the short-lived public token that Link hands back for a durable
   * access token. This is the ONLY point at which an access token is ever
   * obtainable, which is why it belongs in the one-time link step and not in
   * the sync loop.
   */
  async exchangePublicToken(publicToken: string): Promise<string> {
    const response = await this.api.itemPublicTokenExchange({ public_token: publicToken });
    return response.data.access_token;
  }

  /**
   * Deactivates an access token and deletes the Item on Plaid's servers.
   * Plaid will immediately stop tracking transactions and webhooks for this Item.
   */
  async removeItem(accessToken: string): Promise<void> {
    await this.api.itemRemove({ access_token: accessToken });
  }

  /**
   * Creates a Link token so a human can connect a bank in a browser.
   *
   * `redirectUri` must exactly match a redirect URI registered on the Plaid
   * dashboard, otherwise Plaid silently refuses to return a public token.
   * The token itself is short-lived and is never persisted.
   */
  async createLinkToken(
    redirectUri?: string,
    userId = "homelab-owner",
  ): Promise<string> {
    const buildRequest = (uri?: string) => ({
      user: { client_user_id: userId },
      client_name: this.clientName,
      products: [Products.Transactions],
      optional_products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: "en",
      ...(uri ? { redirect_uri: uri } : {}),
      // Ask Plaid to start sending webhooks for this Item from the moment it is
      // created. Omitted entirely when unset, since sending `webhook: undefined`
      // is not the same as omitting it.
      ...(this.config.webhookUrl ? { webhook: this.config.webhookUrl } : {}),
    });

    try {
      const response = await this.api.linkTokenCreate(buildRequest(redirectUri));
      return response.data.link_token;
    } catch (err: unknown) {
      if (
        redirectUri &&
        plaidErrorCode(err) === "INVALID_FIELD" &&
        describePlaidError(err).toLowerCase().includes("redirect uri")
      ) {
        log.warn(
          "Plaid rejected redirect_uri '%s' because it is not configured in the Plaid Developer Dashboard. " +
            "Falling back to non-OAuth Link token so sandbox testing can proceed.",
          redirectUri,
        );
        const fallback = await this.api.linkTokenCreate(buildRequest(undefined));
        return fallback.data.link_token;
      }
      throw err;
    }
  }

  /**
   * Backfill for an item's very first sync, bounded to a date window.
   *
   * `transactionsSync` always replays everything Plaid still retains, which
   * for a long-lived account can be years. `transactions/get` supports date
   * filtering, so it is the right tool for the one-time bootstrap. It is NOT
   * incremental, which is why it is used only here and never in the steady
   * state loop.
   */
  async transactionsInRange(
    accessToken: string,
    startDate: string,
    endDate: string,
  ): Promise<Transaction[]> {
    const all: Transaction[] = [];
    let offset = 0;
    const pageSize = 500;

    for (;;) {
      const response = await this.api.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: pageSize, offset },
      });
      all.push(...(response.data.transactions ?? []));
      if (all.length >= response.data.total_transactions) break;
      offset += pageSize;
    }

    return all;
  }

  /**
 * Registers an ITEM webhook so Plaid sends `SYNC_UPDATES_AVAILABLE` for this
 * Item.
 *
 * This is the correct mechanism for an Item consumed via
 * `/transactions/sync`. The transaction webhooks (`DEFAULT_UPDATE` etc.) are
 * NOT delivered for sync-based Items — registering those and waiting for them
 * is the classic way to build an integration that never syncs.
 *
 * Idempotent: re-registering the same URL is a no-op on Plaid's side.
 */
async addSyncUpdatesWebhook(accessToken: string, webhookUrl: string): Promise<void> {
    // The SDK exposes both /item/webhook/sync_updates/add and the transaction
    // webhook variant through this single endpoint; setting `webhook` is what
    // opts the Item into SYNC_UPDATES_AVAILABLE. Passing null would REMOVE the
    // webhook, so it must never be sent as undefined-but-present.
    await this.api.itemWebhookUpdate({
      access_token: accessToken,
      webhook: webhookUrl,
    });
  }

/**
 * Asks what changed since the last SYNC_UPDATES_AVAILABLE webhook.
 *
 * NOT implemented: Plaid's `/item/webhook/sync_updates/get` is not exposed by
 * the official Node SDK (v48), and it is not needed. That endpoint exists only
 * to tell you *whether* something changed; the changes themselves are read
 * from the `/transactions/sync` cursor either way, so draining the webhook is
 * an optimisation, not a requirement.
 *
 * Leave this webhooks accumulate unread if you want belt-and-braces; the next
 * scheduled sync still pulls the same deltas from the cursor.
 */

/**
 * Creates an UPDATE-MODE Link token for an Item whose OAuth grant lapsed.
 *
 * Passing the existing `access_token` alongside the normal create params is
 * what puts Link into update mode: the user re-authenticates (including MFA)
 * against the SAME Item, and Plaid returns a rotated access token. Crucially
 * this preserves the Item identity, which is what lets the `/transactions/sync`
 * cursor stay valid — creating a fresh Link instead would orphan the history.
 */
  async createUpdateLinkToken(accessToken: string, redirectUri?: string): Promise<string> {
    const buildRequest = (uri?: string) => ({
      user: { client_user_id: "homelab-owner" },
      client_name: this.clientName,
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      access_token: accessToken,
      ...(uri ? { redirect_uri: uri } : {}),
      // Re-sent on update so the URL survives the token rotation.
      ...(this.config.webhookUrl ? { webhook: this.config.webhookUrl } : {}),
    });

    try {
      const response = await this.api.linkTokenCreate(buildRequest(redirectUri));
      return response.data.link_token;
    } catch (err: unknown) {
      if (
        redirectUri &&
        plaidErrorCode(err) === "INVALID_FIELD" &&
        describePlaidError(err).toLowerCase().includes("redirect uri")
      ) {
        log.warn(
          "Plaid rejected redirect_uri '%s' because it is not configured in the Plaid Developer Dashboard. " +
            "Falling back to non-OAuth update mode Link token.",
          redirectUri,
        );
        const fallback = await this.api.linkTokenCreate(buildRequest(undefined));
        return fallback.data.link_token;
      }
      throw err;
    }
  }

/**
 * Point-in-time investment balances.
 *
 * `/investments/*` is NOT incremental and has no cursor — it is a snapshot of
 * "now". These balances are therefore only ever used to set an Actual account
 * balance, never to synthesise transactions.
 *
 * The balance comes from `accounts[].balances.current`, not from summing
 * `holdings`: a brokerage holds uninvested cash that appears in no holding,
 * so summing holdings alone understates the account by the cash balance.
 */
async investmentHoldings(accessToken: string): Promise<{
  accounts: InvestmentAccountBalanceInfo[];
  holdings: Holding[];
  securities: Security[];
}> {
  const response = await this.api.investmentsHoldingsGet({ access_token: accessToken });

  const accounts: InvestmentAccountBalanceInfo[] = (response.data.accounts ?? []).map(
    (account) => ({
      accountId: account.account_id,
      name: account.official_name ?? account.name,
      current: account.balances?.current ?? 0,
      available: account.balances?.available ?? null,
    }),
  );

  return {
    accounts,
    holdings: response.data.holdings ?? [],
    securities: response.data.securities ?? [],
  };
}

/** Dividends, interest, buys and sells for an investment account over a window. */
async investmentTransactions(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<PlaidInvestmentTransaction[]> {
  const response = await this.api.investmentsTransactionsGet({
    access_token: accessToken,
    start_date: startDate,
    end_date: endDate,
  });
  return response.data.investment_transactions ?? [];
}

/**
 * Fetches the next page of transaction changes for an item.
   *
   * Pass the cursor returned by the previous call; pass `undefined` to start
   * from the beginning (which replays all history Plaid still retains).
   * `added` covers both brand new and backfilled transactions, so a given
   * transaction can appear in `added` long before its posting date.
   */
  async transactionsSync(accessToken: string, cursor?: string): Promise<SyncDelta> {
    const response = await this.api.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });

    const { added, modified, removed, next_cursor, has_more } = response.data;

    if (!has_more) {
      return {
        added: added ?? [],
        modified: modified ?? [],
        removed: removed ?? [],
        nextCursor: next_cursor ?? cursor ?? "",
      };
    }

    // Plaid pages sync results. Recurse and merge rather than making the
    // caller loop, so a partially-synced item can never be committed as
    // complete state.
    const rest = await this.transactionsSync(accessToken, next_cursor ?? undefined);
    return {
      added: [...(added ?? []), ...rest.added],
      modified: [...(modified ?? []), ...rest.modified],
      removed: [...(removed ?? []), ...rest.removed],
      nextCursor: rest.nextCursor,
    };
  }
}