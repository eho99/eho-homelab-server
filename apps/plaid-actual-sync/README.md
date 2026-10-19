# plaid-actual-sync

Syncs bank transactions from the Plaid API into a self-hosted
[Actual Budget](https://actualbudget.org) instance, on a schedule.

Part of the `eho-homelab-server` stack. Runs as a background worker alongside
`actual-server` on the same Docker bridge network.

---

## What it does

| Plaid account type | Source | How it reaches Actual |
| --- | --- | --- |
| Checking / savings (BoA, Chase) | `/transactions/sync` | Imported as transactions, cursor-based |
| Credit cards (Amex) | `/transactions/sync` | Imported as transactions, cursor-based |
| Investments (Schwab, Fidelity) | `/investments/transactions/get` + `/investments/holdings/get` | Cash flows as transactions + a balance adjustment |

Additionally it:

- **Removes ghost transactions.** When Plaid reports a transaction as removed
  (a dropped pending charge, a reversed posting) the matching row is deleted
  from Actual instead of lingering forever.
- **Re-authenticates expired institutions.** Chase and BoA OAuth grants lapse
  periodically. This catches `ITEM_LOGIN_REQUIRED` and serves a small page
  that re-links the account in Plaid's *update mode*, rotating the token
  **without** losing history.

---

## Architecture notes worth knowing before you change anything

### Actual has no REST API

The official client (`@actual-app/api`) downloads a full local copy of the
budget into `DATA_DIR` and runs the real budgeting engine against that local
SQLite file, syncing with the server. Consequences:

- `DATA_DIR` **must** be a persistent volume, or every restart re-downloads the
  entire budget.
- The client is reconnected once per cycle rather than reused.

### Amounts are integer cents

Actual stores money as integers. `$12.34` is `1234`. All conversion happens in
one place (`ActualClient.importTransactions`, via `utils.amountToInteger`), so
no other code needs to think about it.

### The sign convention flips between sources

- Plaid `/transactions/sync`: **positive = money leaving the account.**
- Plaid `/investments/*`: the sign already reflects direction (a buy is
  negative, a dividend positive) — the **same** convention Actual uses.
- Actual: **negative = spending.**

So transactional imports negate Plaid's amount and investment imports do not.
Getting this wrong silently turns expenses into income.

### Deduplication is two-layered

1. Plaid's `transaction_id` is stored in Actual's `imported_id`. This is the
   real guard and survives losing this project's state file.
2. A local `seen` set in `state.json` avoids the API round-trip entirely.

Both are needed: (1) is authoritative but only helps if Actual honours it,
(2) is fast but is lost if the volume is wiped.

### Investment balances are faked, deliberately

Actual has **no API for setting an account balance** — `createAccount` accepts
an opening balance and nothing updates it afterwards.

Because an Actual account's balance is always the sum of its transactions,
syncing a brokerage means posting a single synthetic *adjustment* transaction
that makes the sum equal Plaid's reported total. Each cycle the previous
adjustment is deleted and a fresh one posted, so repeated syncs converge on
exactly one adjustment instead of accumulating them.

Consequences you should be aware of:

- The brokerage account is a **value tracker**, not a security-by-security
  ledger. It answers "what is this worth", not "what do I hold".
- **Buys and sells are not imported.** They move value between cash and
  securities without changing the total, so importing them would double-count.
- Dividends, interest, fees, taxes, contributions and withdrawals *are*
  imported, as they are genuine cash flows.

### Cursor preservation on re-auth

A Plaid access token is only ever returned by the public-token exchange — it
cannot be looked up later. It is stored in `state.json`.

Update mode (passing the existing `access_token` to `/link/token/create`)
preserves the *Item identity*, which is what keeps the `/transactions/sync`
cursor valid. Creating a fresh Link instead would orphan all prior history.
`StateStore.clearNeedsReauth` therefore deliberately leaves `cursor` alone.

---

## Layout

```
apps/plaid-actual-sync/
├── src/
│   ├── index.ts         worker entrypoint + scheduler
│   ├── server.ts        re-auth web page and JSON API (Express)
│   ├── config.ts        env parsing/validation, fails fast at boot
│   ├── plaid.ts         Plaid API wrapper
│   ├── actual.ts        Actual API wrapper
│   ├── investments.ts   Schwab/Fidelity path
│   ├── sync.ts          orchestration
│   ├── state.ts         persistent cursors, dedupe set, account mapping
│   └── errors.ts        Plaid error classification (reauth/transient/fatal)
├── e2e/link.spec.ts     Playwright suite against Plaid sandbox
├── Dockerfile           one file, two targets: runtime (default) and e2e
└── .env.example
```

## Setup

Two phases. You can stop after the first.

### Phase 1 — connect banks and check the data (no Actual needed)

Actual Budget configuration is **optional**. Leave `ACTUAL_URL`,
`ACTUAL_PASSWORD` and `ACTUAL_BUDGET_ID` unset and the app runs in
Plaid-only mode: connect accounts and preview transactions from the dashboard,
and nothing is ever written to a budget.

```sh
cp apps/plaid-actual-sync/.env.example apps/plaid-actual-sync/.env
# Fill in PLAID_CLIENT_ID, PLAID_SECRET (Sandbox keys),
# and WEB_USERNAME / WEB_PASSWORD.
docker compose up -d --build plaid-sync
```

Open `https://<host>:9444`, click **Connect account**, then **Refresh
preview**. This is the fastest way to answer "is my bank link working?" — real
transactions on screen without a budget in the picture.

> Register `<PUBLIC_URL>/callback` as an allowed redirect URI on the Plaid
> dashboard first, or the redirect fails silently.

### Phase 2 — enable syncing

Uncomment and fill in the three `ACTUAL_*` variables, then restart:

```sh
docker compose up -d --build plaid-sync
docker compose logs -f plaid-sync
```

The dashboard gains a **Sync to Actual now** button. Confirm the startup line
reads `actual=configured`, not `actual=PLAID-ONLY`.

```sh
docker compose exec plaid-sync node dist/index.js --once
```

Look for `imported N, skipped 0 duplicate(s)`, then confirm in Actual's UI.
**Check the sign direction** — expenses must be negative. If they read as
income, the sign convention is inverted and must be fixed before going further.

Run it a second time. You want `imported 0` — that is your dedupe proof.

## Dashboard

Served at `https://<node>.ts.net:9444` (Tailscale Serve → Caddy `:8083`),
protected by `WEB_USERNAME` / `WEB_PASSWORD`. This port is published on
loopback only and is deliberately not reachable from the LAN.

- **Connect account** — opens Plaid Link for a new institution.
- **Refresh preview** — reads raw Plaid data, bypassing Actual entirely.
  Amounts are shown **un-negated**, exactly as Plaid returned them
  (positive = money leaving the account).
- **Re-authenticate** — per institution, for expired OAuth grants.
- **Sync to Actual now** — only present when Actual is configured.

Preview uses `/transactions/get` (date-ranged) rather than
`/transactions/sync`, so opening the dashboard **cannot** advance the sync
cursor and swallow transactions the real sync would then never see.

> **Set both `WEB_USERNAME` and `WEB_PASSWORD`.** With them unset the page
> still starts, logs a warning, and is reachable by anyone who can reach the
> port — and it can initiate a bank login.

`PUBLIC_URL` must exactly match the redirect URI registered on the Plaid
dashboard, scheme and port included, or Plaid silently returns no token.

## Testing against Plaid sandbox

```sh
docker compose --profile e2e run --rm plaid-sync-e2e
```

Requires sandbox credentials in `.env` plus a running `actual-server`.

> Plaid Link renders in a cross-origin iframe and Plaid discourages
> automating it. The selectors in `e2e/link.spec.ts` are text/role-based and
> may break when Plaid changes its UI. A failing e2e run does not necessarily
> mean the integration is broken — run `npm run typecheck` to tell the two
> apart.

## Configuration

See `.env.example` for the annotated full list. The ones that matter most:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACTUAL_URL` | `http://actual-server:5006` | Compose-internal URL. Keeps traffic on plain HTTP and avoids TLS entirely. |
| `SYNC_INTERVAL_MINUTES` | `360` | How often to sync. |
| `INITIAL_SYNC_DAYS` | `90` | Backfill window on an item's first sync. |
| `INVESTMENT_WINDOW_DAYS` | `30` | Rolling window for `/investments/*`. |
| `DELETE_REMOVED_TRANSACTIONS` | `true` | Delete ghost rows. Set `false` to log-only. |
| `ENABLED` | `true` | Set `false` to boot the worker without syncing. |

### TLS

Caddy no longer terminates TLS. HTTPS for the `*.ts.net` names is terminated by
Tailscale Serve, which holds a real Let's Encrypt certificate and forwards to
Caddy's loopback ports in plaintext. `ACTUAL_URL` points at the container
directly, so the worker stays on plain HTTP too. There is no certificate to
generate or trust anywhere in this path.

## Troubleshooting

**`caddy` is stuck in `Restarting (1)`**

Caddy now reads no certificate files, so this is no longer the certificate
problem it used to be. Check the Caddyfile against the compose ports — a
mismatched upstream container name or port is the usual cause:

```sh
docker compose logs caddy | tail -20
docker compose config --quiet
```

**`Unable to get local issuer certificate` when browsing a service**

Docker is publishing a port on `0.0.0.0` that Tailscale Serve needs to bind, so
the wildcard listener wins and you reach Caddy directly instead of Serve.
`scripts/apply-serve.sh` reports this; confirm nothing else holds the port:

```sh
lsof -nP -iTCP:443 -sTCP:LISTEN
scripts/apply-serve.sh
```

**Item shows "Needs re-authentication"**
Expected for Chase/BoA after a few weeks. Open the re-auth page on `:9444` and
click through. The MFA prompt is real — it is the bank asking *you*, which is
why a machine cannot do it for you.

**`PRODUCT_NOT_READY`**
Plaid is still fetching initial history. Harmless; it resolves on a later cycle.

**Transactions import as income**
The sign convention was inverted somewhere. See "Architecture notes".

**Duplicate transactions after a restart**
The `plaid-sync/` volume was deleted, or `imported_id` is not being set.
Check `state.json` and that `imported_id` is present on imported rows.

**Investment balance looks wrong**
Check the logs for "adjusting investment account". If the delta is large every
cycle, the brokerage account has manual transactions fighting the adjustment.