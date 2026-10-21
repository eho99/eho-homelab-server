/**
 * A small HTTP surface for re-authenticating expired Plaid Items.
 *
 * WHY THIS EXISTS: Plaid OAuth grants for large institutions (Chase, BoA)
 * lapse periodically. When they do, /transactions/sync starts returning
 * ITEM_LOGIN_REQUIRED and the only remedy is for a human to re-consent,
 * including an MFA prompt. Update mode is the only way to do that without
 * destroying the Item's history — and history is what the sync cursor points
 * at, so re-linking from scratch would silently orphan every prior
 * transaction.
 *
 * This server therefore:
 *   1. shows which Items need attention,
 *   2. mints an update-mode link token per Item,
 *   3. receives the redirect, exchanges the public token, and swaps in the
 *      rotated access token WITHOUT touching the cursor.
 *
 * SECURITY: this page can initiate a bank login, so it is not open. It is
 * protected by HTTP basic auth and is intended to sit behind the Caddy
 * reverse proxy in this homelab, never directly on an exposed port.
 */

import express from "express";
import { loadConfig, type Config } from "./config.js";
import { log } from "./logger.js";
import { PlaidClient, toAccountKind } from "./plaid.js";
import { StateStore } from "./state.js";
import { ActualClient } from "./actual.js";
import { runSync, type SyncSummary } from "./sync.js";
import { buildPreview } from "./preview.js";
import { describePlaidError, plaidErrorCode } from "./errors.js";
import { verifyWebhook, classifyWebhook, shouldTriggerSync, describeWebhook } from "./webhooks.js";
import type { SyncCoordinator } from "./coordinator.js";

/**
 * Items whose re-auth page is open, keyed by an opaque nonce.
 *
 * `itemKey` is `null` for a brand-new link and a state key for a re-auth. The
 * distinction is load-bearing: a new link legitimately has no item yet, so
 * `null` must NOT be conflated with "no session found". An earlier version
 * used `""` and rejected every new-link redirect as an expired session.
 *
 * The nonce is unguessable, short-lived, and deliberately NOT derived from the
 * Item id (which is guessable from the status page).
 */
type PendingSession = { itemKey: string | null; expiresAt: number };

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingSessions = new Map<string, PendingSession>();

function newNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolves a nonce to its session.
 *
 * Returns `undefined` only when the nonce is unknown or expired — never for a
 * valid new-link session.
 */
function consumePending(nonce: string): PendingSession | undefined {
  const session = pendingSessions.get(nonce);
  if (!session) return undefined;
  pendingSessions.delete(nonce);
  if (session.expiresAt < Date.now()) return undefined;
  return session;
}

/** Drops expired sessions so the map cannot grow without bound. */
function prunePending(): void {
  const now = Date.now();
  for (const [nonce, session] of pendingSessions) {
    if (session.expiresAt < now) pendingSessions.delete(nonce);
  }
}

/**
 * Basic auth guard.
 *
 * Skipped only when no credentials are configured, and that case is logged
 * loudly, because an unprotected endpoint here can initiate a bank login.
 */
const activeSessions = new Set<string>();

function parseCookies(req: express.Request): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  for (const cookie of rc.split(";")) {
    const parts = cookie.split("=");
    const key = parts.shift()?.trim();
    if (key) {
      list[key] = decodeURIComponent(parts.join("=").trim());
    }
  }
  return list;
}

function isAuthenticated(req: express.Request): boolean {
  const user = process.env.WEB_USERNAME;
  const pass = process.env.WEB_PASSWORD;
  if (!user || !pass) return true;

  // 1. Check HTTP Basic auth header
  const expectedBasic = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  if (req.headers.authorization === expectedBasic) return true;

  // 2. Check session cookie
  const cookies = parseCookies(req);
  if (cookies.session_token && activeSessions.has(cookies.session_token)) {
    return true;
  }

  return false;
}

function authGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

/**
 * A dedicated, minimal webhook receiver on its own port.
 *
 * WHY THIS EXISTS: the dashboard and the webhook both lived on the dashboard
 * port, and the dashboard can initiate bank logins. Exposing that port with
 * Tailscale Funnel would publish the whole thing to the internet behind HTTP
 * basic auth — a poor trade for a latency optimisation.
 *
 * So the webhook gets its own listener whose entire surface is one route,
 * authenticated by Plaid's signed JWT rather than by a password. Funnel this
 * port and the blast radius is exactly one endpoint that returns no data and
 * does nothing without a valid signature.
 */
export function createWebhookApp(
  config: Config,
  coordinator?: SyncCoordinator,
): express.Express {
  const app = express();

  app.post(
    "/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        res.status(400).json({ error: "invalid JSON" });
        return;
      }

      // Verified BEFORE anything is queued. The signed JWT is the entire
      // authentication story here, so it must not be skippable.
      const header = req.header("Plaid-Verification");
      const verdict = await verifyWebhook(config, header, raw);
      if (!verdict.ok) {
        log.warn("Rejected webhook: %s", verdict.reason);
        res.status(401).json({ error: "verification failed" });
        return;
      }

      const event = classifyWebhook(payload);
      log.info("Webhook received: %s", describeWebhook(event));

      if (shouldTriggerSync(event)) {
        // Enqueue, never run inline: Plaid expects a fast response and a sync
        // can take minutes.
        coordinator?.trigger("webhook");
      }

      // 200 with an empty body is what Plaid expects.
      res.status(200).end();
    },
  );

  // Anything else on this port is a misconfiguration or a probe; do not
  // confirm which routes exist.
  app.use((_req, res) => {
    res.status(404).end();
  });

  return app;
}

export function createApp(config: Config, coordinator?: SyncCoordinator): express.Express {
  const app = express();
  const plaid = new PlaidClient(config);
  const store = new StateStore(config.dataDir);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const redirectUri = `${config.publicUrl.replace(/\/$/, "")}/callback`;

  // ---- Auth endpoints (public) -------------------------------------------
  app.get("/api/auth/status", (req, res) => {
    const configured = Boolean(process.env.WEB_USERNAME && process.env.WEB_PASSWORD);
    res.json({
      authenticated: !configured || isAuthenticated(req),
      authRequired: configured,
    });
  });

  app.post("/api/login", (req, res) => {
    const user = process.env.WEB_USERNAME;
    const pass = process.env.WEB_PASSWORD;
    if (!user || !pass) {
      res.json({ ok: true });
      return;
    }

    const { username, password } = req.body || {};
    if (username === user && password === pass) {
      const token = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      activeSessions.add(token);
      res.setHeader(
        "Set-Cookie",
        `session_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      );
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: "Invalid username or password" });
    }
  });

  app.post("/api/logout", (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.session_token) {
      activeSessions.delete(cookies.session_token);
    }
    res.setHeader("Set-Cookie", "session_token=; Path=/; HttpOnly; Max-Age=0");
    res.json({ ok: true });
  });

  // ---- Status page (serves both login & dashboard) -----------------------
  app.get("/", (_req, res) => {
    res.type("html").send(
      renderStatusPage({
        actualEnabled: config.actual.enabled,
        webhookUrl: config.webhookUrl ?? null,
      }),
    );
  });

  // Guard all subsequent /api/* endpoints
  app.use("/api", authGuard);

  // ---- Item list consumed by the status page -----------------------------
  app.get("/api/items", async (_req, res) => {
    await store.load();
    const items = store.listLinkedItems();
    const { lastSyncAt, lastSyncResult } = store.getLastSync();

    const payload = await Promise.all(
      items.map(async ([itemKey, item]) => {
        let plaidAccountCount = Object.keys(item.accountKinds || {}).length;
        if (plaidAccountCount === 0 && item.accessToken) {
          try {
            const accs = await plaid.listAccounts(item.accessToken);
            plaidAccountCount = accs.length;
            item.accountKinds = item.accountKinds || {};
            for (const a of accs) {
              item.accountKinds[a.account_id] = toAccountKind(a.type);
            }
            await store.save();
          } catch {
            // Keep going if Plaid fails
          }
        }

        const syncedCount = Object.keys(item.accountMap || {}).length;

        return {
          itemKey,
          label: item.label ?? itemKey,
          needsReauth: item.needsReauth === true,
          reauthSince: item.reauthSince ?? null,
          plaidAccounts: plaidAccountCount,
          syncedAccounts: syncedCount,
          linkedAccounts: syncedCount,
          hasAccessToken: Boolean(item.accessToken),
          hasCursor: Boolean(item.cursor),
        };
      }),
    );

    res.json({
      items: payload,
      lastSyncAt: lastSyncAt ?? null,
      lastSyncResult: lastSyncResult ?? null,
    });
  });

  // ---- Link a NEW institution (no update mode) --------------------------
  // Used for first-time linking and by the Playwright sandbox suite. It
  // creates a FRESH Item, so it must never be used to fix an expired one —
  // that would orphan the existing cursor and history.
  app.post("/api/link-token", async (_req, res) => {
    try {
      prunePending();
      const linkToken = await plaid.createLinkToken(redirectUri);
      const nonce = newNonce();
      // null, not "": this is a brand-new institution, not a re-auth.
      pendingSessions.set(nonce, { itemKey: null, expiresAt: Date.now() + PENDING_TTL_MS });
      res.json({ linkToken, redirectUri, nonce });
    } catch (err) {
      // Surface Plaid's actual error_code/display_message. The bare Axios
      // message ("Request failed with status code 400") tells you nothing
      // about WHICH field Plaid rejected, which is almost always the cause.
      const detail = describePlaidError(err);
      log.error("Failed to create link token: %s (%s)", detail, plaidErrorCode(err) ?? "no code");
      res.status(502).json({ error: detail, code: plaidErrorCode(err) ?? null });
    }
  });

  // ---- Complete a fresh link (sandbox / e2e path) -----------------------
  app.post("/api/link-token/complete", async (req, res) => {
    const publicToken = String(req.body?.publicToken ?? "");
    const nonce = String(req.body?.nonce ?? "");
    if (!publicToken) {
      res.status(400).json({ error: "publicToken is required" });
      return;
    }

    const session = nonce ? consumePending(nonce) : undefined;
    if (nonce && !session) {
      res.status(400).json({ error: "Link session expired or unknown" });
      return;
    }

    try {
      const accessToken = await plaid.exchangePublicToken(publicToken);
      const info = await plaid.getItem(accessToken);

      await store.load();
      if (session?.itemKey) {
        store.getItem(session.itemKey).accessToken = accessToken;
        store.clearNeedsReauth(session.itemKey);
        await store.save();
      } else {
        store.addItem(accessToken, info.itemId, info.institutionName);
        await store.save();
      }

      log.info("Linked new item %s.", info.institutionName);
      res.json({ ok: true, institution: info.institutionName });
    } catch (err) {
      log.error("Link completion failed: %s", (err as Error).message);
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- Plaid-only preview: NO Actual involvement ------------------------
  // Reads raw Plaid data for every linked item so you can confirm a bank link
  // works before Actual is configured or even running. See preview.ts for why
  // this deliberately cannot advance the sync cursor.
  app.get("/api/preview", async (req, res) => {
    try {
      const days = Number(req.query.days ?? 30);
      if (!Number.isInteger(days) || days <= 0 || days > 730) {
        res.status(400).json({ error: "days must be an integer between 1 and 730" });
        return;
      }

      await store.load();
      const items = await buildPreview(config, plaid, store, days);
      res.json({
        plaidEnv: config.plaid.env,
        actualEnabled: config.actual.enabled,
        days,
        items,
      });
    } catch (err) {
      log.error("Preview failed: %s", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- Trigger a sync on demand ----------------------------------------
  app.post("/api/sync", async (_req, res) => {
    if (!config.actual.enabled) {
      res.status(409).json({
        error:
          "Actual Budget is not configured. Set ACTUAL_URL, ACTUAL_PASSWORD and " +
          "ACTUAL_BUDGET_ID to enable syncing. Preview still works.",
      });
      return;
    }
    try {
      // Routed through the coordinator so a manual sync cannot race the timer
      // or an in-flight webhook-triggered one.
      const summary = coordinator
        ? await coordinator.request("manual")
        : await triggerImmediateSync(config);
      res.json(summary ?? { imported: 0, skippedDuplicates: 0, failures: [] });
    } catch (err) {
      log.error("Manual sync failed: %s", (err as Error).message);
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- Mint an update-mode link token for an Item ------------------------
  app.post("/api/relink", async (req, res) => {
    const itemKey = String(req.body?.itemKey ?? "");
    if (!itemKey) {
      res.status(400).json({ error: "itemKey is required" });
      return;
    }

    const items = store.listLinkedItems();
    const match = items.find(([key]) => key === itemKey);
    if (!match) {
      res.status(404).json({ error: `No linked item with key ${itemKey}` });
      return;
    }

    const [key, item] = match;
    if (!item.accessToken) {
      res.status(409).json({ error: "Item has no access token" });
      return;
    }

    try {
      // This is what switches Plaid Link into update mode.
      const linkToken = await plaid.createUpdateLinkToken(item.accessToken, redirectUri);
      const nonce = newNonce();
      pendingSessions.set(nonce, { itemKey: key, expiresAt: Date.now() + PENDING_TTL_MS });
      res.json({ linkToken, redirectUri, nonce });
    } catch (err) {
      const detail = describePlaidError(err);
      log.error("Failed to create update link token: %s (%s)", detail, plaidErrorCode(err) ?? "no code");
      res.status(502).json({ error: detail, code: plaidErrorCode(err) ?? null });
    }
  });

  // ---- Unlink an institution and revoke its Plaid access token -------------
  app.post("/api/items/unlink", async (req, res) => {
    const itemKey = String(req.body?.itemKey ?? "");
    if (!itemKey) {
      res.status(400).json({ error: "itemKey is required" });
      return;
    }

    try {
      await store.load();
      const item = store.getItem(itemKey);
      if (item.accessToken) {
        try {
          await plaid.removeItem(item.accessToken);
          log.info("Revoked access token at Plaid for %s.", item.label ?? itemKey);
        } catch (err) {
          log.warn("Could not revoke token at Plaid (%s); proceeding with local removal.", (err as Error).message);
        }
      }

      store.removeItem(itemKey);
      await store.save();
      log.info("Unlinked item %s.", item.label ?? itemKey);
      res.json({ ok: true, itemKey });
    } catch (err) {
      log.error("Failed to unlink item %s: %s", itemKey, (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- Plaid redirect: exchange the public token -------------------------
  app.get("/callback", async (req, res) => {
    const publicToken = typeof req.query.public_token === "string" ? req.query.public_token : "";
    const nonce = typeof req.query.nonce === "string" ? req.query.nonce : "";
    const error = typeof req.query.error === "string" ? req.query.error : "";

    if (error) {
      res.status(400).send(renderMessage("Re-authentication failed", `Plaid reported: ${error}`));
      return;
    }

    const session = consumePending(nonce);
    if (!session) {
      res
        .status(400)
        .send(
          renderMessage(
            "Link session expired",
            "This re-authentication link is no longer valid. Reload the dashboard and try again.",
          ),
        );
      return;
    }
    if (!publicToken) {
      res.status(400).send(renderMessage("Missing token", "Plaid did not return a public_token."));
      return;
    }

    const isUpdate = session.itemKey !== null;

    try {
      await store.load();
      const accessToken = await plaid.exchangePublicToken(publicToken);

      if (isUpdate) {
        const itemKey = session.itemKey as string;
        const item = store.getItem(itemKey);
        item.accessToken = accessToken;
        // The cursor is intentionally preserved: it indexes the institution's
        // transaction history, not the token, so the rotated token resumes
        // exactly where the previous one stopped.
        store.clearNeedsReauth(itemKey);
        await store.save();

        log.info("Re-authenticated %s; access token rotated.", item.label ?? itemKey);

        // Resume syncing immediately so the user sees fresh data without
        // waiting out the interval. Only meaningful when Actual is configured.
        if (config.actual.enabled) {
          void triggerImmediateSync(config).catch((err) =>
            log.error("Post-re-auth sync failed: %s", (err as Error).message),
          );
        }
      } else {
        const info = await plaid.getItem(accessToken);
        store.addItem(accessToken, info.itemId, info.institutionName);
        await store.save();
        log.info("Linked new item %s.", info.institutionName);
      }

      res
        .status(200)
        .send(renderMessage("Connection complete", "Returning to the dashboard…"));
    } catch (err) {
      log.error("Link exchange failed: %s", (err as Error).message);
      res.status(500).send(renderMessage("Connection failed", (err as Error).message));
    }
  });

  return app;
}

/** Runs one sync cycle on its own connection, then tears it down. */
async function triggerImmediateSync(config: Config): Promise<SyncSummary> {
  const plaid = new PlaidClient(config);
  const store = new StateStore(config.dataDir);
  await store.load();

  const actual = new ActualClient(config);

  try {
    await actual.connect();
    return await runSync(config, plaid, actual, store);
  } finally {
    await actual.shutdown();
  }
}

interface PageOptions {
actualEnabled: boolean;
  webhookUrl: string | null;
}

function renderStatusPage(opts: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plaid dashboard</title>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<style>
  /* Explicit colour variables rather than "color: inherit" on buttons.
     color-scheme: light dark makes the UA pick a dark palette, so body text
     is near-white; inheriting that onto a hardcoded #fff button background
     renders white-on-white and the button label disappears entirely. Every
     foreground/background pair below is fixed, so both schemes stay legible. */
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --fg: #14181f;
    --muted: #5b6472;
    --card: #ffffff;
    --line: #d6dae0;
    --btn-bg: #ffffff;
    --btn-fg: #14181f;
    --primary-bg: #1a56db;
    --primary-fg: #ffffff;
    --ok: #137333;
    --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181f;
      --fg: #e8eaed;
      --muted: #9aa3af;
      --card: #1e232b;
      --line: #333a44;
      --btn-bg: #262c35;
      --btn-fg: #e8eaed;
      --primary-bg: #4b8bff;
      --primary-fg: #0b1220;
      --ok: #6ee7a0;
      --bad: #ff9d94;
    }
  }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg);
         max-width: 60rem; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { margin-bottom: .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  .sub { color: var(--muted); margin-top: 0; }
  .bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: 1.5rem 0; }
  button { padding: .5rem 1rem; border-radius: .375rem; border: 1px solid var(--line);
           background: var(--btn-bg); color: var(--btn-fg); cursor: pointer; font-size: .95rem; }
  button:hover:not(:disabled) { border-color: var(--muted); }
  button:focus-visible { outline: 2px solid var(--primary-bg); outline-offset: 2px; }
  button.primary { background: var(--primary-bg); border-color: var(--primary-bg);
                   color: var(--primary-fg); font-weight: 600; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .card { border: 1px solid var(--line); background: var(--card);
          border-radius: .5rem; padding: 1rem; margin: .75rem 0; }
  .ok { color: var(--ok); } .bad { color: var(--bad); font-weight: 600; }
  .muted { color: var(--muted); }
  .pill { display: inline-block; font-size: .75rem; padding: .1rem .5rem; border-radius: 1rem;
          border: 1px solid var(--line); color: var(--muted); margin-left: .4rem; vertical-align: middle; }
  table { border-collapse: collapse; width: 100%; font-size: .875rem; margin-top: .5rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pending { font-style: italic; opacity: .75; }
  .scroll { max-height: 26rem; overflow-y: auto; }
  code { background: #8882; padding: .1rem .3rem; border-radius: .25rem; font-size: .85em; }
  .form-group { margin-bottom: 1rem; }
  .form-group label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .25rem; }
  .form-group input { width: 100%; box-sizing: border-box; padding: .55rem .75rem; border-radius: .375rem;
                      border: 1px solid var(--line); background: var(--card); color: var(--fg); font-size: 1rem; }
  .form-group input:focus { outline: 2px solid var(--primary-bg); outline-offset: 1px; }
  .login-card { max-width: 24rem; margin: 3rem auto; }
</style>
</head>
<body>

<div id="login-section" style="display: none;">
  <div class="card login-card">
    <h2 style="margin-top: 0;">Sign in</h2>
    <p class="sub">Enter your credentials to access the Plaid dashboard.</p>
    <form id="login-form" onsubmit="handleLogin(event)">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" autocomplete="username" required>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required>
      </div>
      <button type="submit" id="login-btn" class="primary" style="width: 100%;">Log in</button>
      <div id="login-error" class="bad" style="margin-top: .75rem; display: none;"></div>
    </form>
  </div>
</div>

<div id="dashboard-section" style="display: none;">
  <div style="display: flex; justify-content: space-between; align-items: baseline;">
    <h1>Plaid dashboard</h1>
    <button id="logout-btn" onclick="handleLogout()" style="display: none; font-size: .85rem; padding: .25rem .75rem;">Log out</button>
  </div>
  <p class="sub">Connect bank accounts and inspect what Plaid returns — independently of Actual Budget.</p>

  <div class="bar">
    <button class="primary" id="connect" onclick="connectBank(this)">Connect account</button>
    <button onclick="loadPreview(this)">Refresh preview</button>
    ${opts.actualEnabled ? '<button onclick="runSync(this)">Sync to Actual now</button>' : ""}
    <span id="banner" class="muted"></span>
  </div>

  ${
    opts.actualEnabled
      ? ""
      : `<div class="card">
    <strong class="bad">Actual Budget is not configured.</strong>
    <div class="muted">Syncing is disabled, but connecting accounts and previewing works normally.
    Set <code>ACTUAL_URL</code>, <code>ACTUAL_PASSWORD</code> and <code>ACTUAL_BUDGET_ID</code> to enable it.</div>
  </div>`
  }

  <h2>Last sync</h2>
  <div class="card" id="last-sync-card">
    <div id="last-sync-content" class="muted">Loading…</div>
  </div>

  <h2>Connected accounts</h2>
  <div id="items">Loading…</div>

  <h2>Delivery</h2>
  <div class="card">
    ${
      opts.webhookUrl
        ? `<div><span class="ok">Webhooks enabled</span></div>
           <div class="muted">Plaid posts to <code>${escapeHtml(opts.webhookUrl)}</code>.
           The scheduled sync still runs regardless — a missed webhook only delays data, it never loses it.</div>`
        : `<div><span class="muted">Webhooks disabled</span></div>
           <div class="muted">Scheduled syncing only. Set <code>PLAID_WEBHOOK_URL</code> to a public
           HTTPS URL to have Plaid push updates instead of waiting for the timer.</div>`
    }
  </div>

  <h2>Transaction preview <span class="muted" style="font-size:.85em;font-weight:400">— raw Plaid output, not yet sent to Actual</span></h2>
  <div id="preview" class="muted">Click “Refresh preview”.</div>
</div>

<script>
let authRequired = false;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    authRequired = Boolean(data.authRequired);
    if (data.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
  }
}

function showDashboard() {
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('dashboard-section').style.display = 'block';
  document.getElementById('logout-btn').style.display = authRequired ? 'inline-block' : 'none';
  load();
}

function showLogin() {
  document.getElementById('dashboard-section').style.display = 'none';
  document.getElementById('login-section').style.display = 'block';
  const errBox = document.getElementById('login-error');
  if (errBox) {
    errBox.textContent = '';
    errBox.style.display = 'none';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errBox = document.getElementById('login-error');
  const user = document.getElementById('username').value;
  const pass = document.getElementById('password').value;

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errBox.style.display = 'none';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Invalid username or password');
    }
    showDashboard();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log in';
  }
}

async function handleLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    showLogin();
  }
}

function setBanner(text) { document.getElementById('banner').textContent = text || ''; }

// --- Connecting / re-authenticating -------------------------------------
// Both flows end the same way: Plaid hands back a public token, which we send
// to our own server to exchange. The exchange MUST happen server-side because
// it needs the Plaid secret, which must never reach the browser.
function plaidSession(linkToken, redirectUri, nonce, button, label) {
  const handler = window.Plaid.create({
    token: linkToken,
    onSuccess: (publicToken) => {
      const target = new URL('/callback', window.location.href);
      target.searchParams.set('public_token', publicToken);
      target.searchParams.set('nonce', nonce);
      window.location.href = target.toString();
    },
    onExit: () => { button.disabled = false; button.textContent = label; }
  });
  handler.open();
}

async function connectBank(button) {
  button.disabled = true;
  button.textContent = 'Starting…';
  setBanner('');
  try {
    const res = await fetch('/api/link-token', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { linkToken, redirectUri, nonce } = await res.json();
    plaidSession(linkToken, redirectUri, nonce, button, 'Connect account');
  } catch (err) {
    alert('Could not start linking: ' + err.message);
    button.disabled = false;
    button.textContent = 'Connect account';
  }
}

async function relink(item, button) {
  button.disabled = true;
  button.textContent = 'Starting…';
  setBanner('');
  try {
    const res = await fetch('/api/relink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemKey: item.itemKey })
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { linkToken, redirectUri, nonce } = await res.json();
    plaidSession(linkToken, redirectUri, nonce, button, 'Re-authenticate');
  } catch (err) {
    alert('Could not start re-authentication: ' + err.message);
    button.disabled = false;
    button.textContent = 'Re-authenticate';
  }
}

async function runSync(button) {
  button.disabled = true; button.textContent = 'Syncing…'; setBanner('');
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    setBanner('Synced: ' + body.imported + ' imported, ' + body.skippedDuplicates + ' skipped.');
    await load();
  } catch (err) {
    alert('Sync failed: ' + err.message);
  } finally {
    button.disabled = false; button.textContent = 'Sync to Actual now';
  }
}

// --- Item list -----------------------------------------------------------
async function load() {
  const res = await fetch('/api/items');
  if (res.status === 401) { showLogin(); return; }
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.items || []);
  const lastSyncAt = Array.isArray(data) ? null : data.lastSyncAt;
  const lastSyncResult = Array.isArray(data) ? null : data.lastSyncResult;

  const lastSyncEl = document.getElementById('last-sync-content');
  if (lastSyncEl) {
    if (lastSyncAt) {
      const dateStr = new Date(lastSyncAt).toLocaleString();
      let summaryStr = '';
      if (lastSyncResult) {
        summaryStr = '<div class="muted" style="margin-top: .25rem; font-size: .9rem;">' +
          'Imported: <strong>' + (lastSyncResult.imported || 0) + '</strong>, ' +
          'Skipped: <strong>' + (lastSyncResult.skippedDuplicates || 0) + '</strong>' +
          (lastSyncResult.failures && lastSyncResult.failures.length
            ? ' <span class="bad">(' + lastSyncResult.failures.length + ' failure(s))</span>'
            : '') +
          '</div>';
      }
      lastSyncEl.innerHTML = '<div><span class="ok">✓ Last synced</span> <strong>' + esc(dateStr) + '</strong></div>' + summaryStr;
    } else {
      lastSyncEl.innerHTML = '<span class="muted">No sync recorded yet.</span>';
    }
  }

  const box = document.getElementById('items');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<p class="muted">No accounts connected yet. Use “Connect account”.</p>';
    return;
  }

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'card';
    const status = item.needsReauth
      ? '<span class="bad">Needs re-authentication' +
        (item.reauthSince ? ' (since ' + new Date(item.reauthSince).toLocaleString() + ')' : '') + '</span>'
      : '<span class="ok">Connected</span>';
    const acctCount = item.plaidAccounts || item.linkedAccounts;
    div.innerHTML =
      '<div><strong>' + esc(item.label) + '</strong></div>' +
      '<div>' + status +
        '<span class="pill">' + acctCount + ' Plaid account(s)</span>' +
        (item.hasCursor
          ? '<span class="pill ok">synced (' + (item.syncedAccounts || 0) + ' in Actual)</span>'
          : '<span class="pill">not yet synced to Actual</span>') +
      '</div>';
    const btn = document.createElement('button');
    btn.textContent = 'Re-authenticate';
    btn.onclick = () => relink(item, btn);

    const unlinkBtn = document.createElement('button');
    unlinkBtn.textContent = 'Disconnect';
    unlinkBtn.style.marginLeft = '.5rem';
    unlinkBtn.style.color = 'var(--bad)';
    unlinkBtn.onclick = async () => {
      if (!confirm('Are you sure you want to disconnect ' + item.label + '? This will revoke the connection at Plaid and stop syncing.')) return;
      unlinkBtn.disabled = true;
      unlinkBtn.textContent = 'Disconnecting…';
      try {
        const res = await fetch('/api/items/unlink', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemKey: item.itemKey })
        });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        setBanner('Disconnected ' + item.label + '.');
        await load();
        const previewBox = document.getElementById('preview');
        if (previewBox) previewBox.innerHTML = '<span class="muted">Click “Refresh preview”.</span>';
      } catch (err) {
        alert('Failed to disconnect: ' + err.message);
        unlinkBtn.disabled = false;
        unlinkBtn.textContent = 'Disconnect';
      }
    };

    div.appendChild(document.createElement('br'));
    div.appendChild(btn);
    div.appendChild(unlinkBtn);
    box.appendChild(div);
  }
}

// --- Preview -------------------------------------------------------------
async function loadPreview(button) {
  if (button) { button.disabled = true; button.textContent = 'Loading…'; }
  setBanner('');
  const box = document.getElementById('preview');
  box.innerHTML = '<span class="muted">Reading from Plaid…</span>';
  try {
    const res = await fetch('/api/preview?days=30');
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (data.error) { box.innerHTML = '<span class="bad">' + esc(data.error) + '</span>'; return; }
    box.innerHTML = '';
    if (!data.items.length) {
      box.innerHTML = '<span class="muted">No connected accounts to preview.</span>';
      return;
    }
    for (const item of data.items) box.appendChild(renderItem(item));
  } catch (err) {
    box.innerHTML = '<span class="bad">' + esc(err.message) + '</span>';
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Refresh preview'; }
  }
}

function renderItem(item) {
  const wrap = document.createElement('div');
  wrap.className = 'card';

  if (item.error) {
    wrap.innerHTML = '<div><strong>' + esc(item.label) + '</strong></div>' +
      '<div class="' + (item.stillLoading ? 'muted' : 'bad') + '">' + esc(item.error) + '</div>';
    return wrap;
  }

  const acctRows = item.accounts.map(a =>
    '<tr><td>' + esc(a.name) + '</td><td class="muted">' + esc(a.kind) +
    (a.mask ? ' ····' + esc(a.mask) : '') + '</td>' +
    '<td class="num">' + (a.balance === null ? '—' : money(a.balance)) + '</td></tr>'
  ).join('');

  let body = '';
  if (item.transactions && item.transactions.length) {
    const rows = item.transactions.slice(0, 200).map(t =>
      '<tr class="' + (t.pending ? 'pending' : '') + '">' +
      '<td>' + esc(t.date) + '</td>' +
      '<td>' + esc(t.merchantName || t.name) + (t.pending ? ' <span class="muted">(pending)</span>' : '') + '</td>' +
      '<td class="muted">' + esc(t.accountName) + '</td>' +
      '<td class="num">' + money(t.amount) + '</td></tr>').join('');
    body += '<div class="scroll"><table>' +
      '<tr><th>Date</th><th>Description</th><th>Account</th><th class="num">Amount</th></tr>' +
      rows + '</table></div>' +
      '<p class="muted">' + item.transactions.length + ' transaction(s) in the last 30 days' +
      (item.transactions.length > 200 ? ' (showing first 200)' : '') +
      '. Positive amounts are money leaving the account.</p>';
  } else if (!item.investments) {
    body += '<p class="muted">No transactions in the last 30 days.</p>';
  }

  if (item.investments && item.investments.length) {
    body += '<table><tr><th>Account</th><th></th><th class="num">Value</th></tr>' +
      item.investments.map(i =>
        '<tr><td>' + esc(i.name) + '</td><td class="muted">investment</td>' +
        '<td class="num">' + money(i.current) + '</td></tr>').join('') + '</table>' +
        '<p class="muted">Investment items have no transaction feed to preview.</p>';
  }

  wrap.innerHTML = '<div><strong>' + esc(item.label) + '</strong></div>' +
    '<table><tr><th>Account</th><th>Type</th><th class="num">Balance</th></tr>' + acctRows + '</table>' + body;
  return wrap;
}

function money(n) {
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

checkAuth();
</script>
</body>
</html>`;
}

function renderMessage(title: string, detail: string): string {
  const safe = escapeHtml(detail);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="2;url=/">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${safe}</p>
<p class="muted">Returning to dashboard in a moment… <a href="/">Click here if not redirected automatically</a>.</p>
<script>setTimeout(function(){ window.location.href = '/'; }, 1500);</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}