/**
 * Worker entrypoint.
 *
 * Two things drive syncs, and both go through the same coordinator so they
 * can never run concurrently against the same cursors:
 *
 *   - the interval timer (the backbone — this is what guarantees correctness)
 *   - Plaid webhooks   (an accelerator — makes syncs happen sooner)
 *
 * The timer is the one that matters. Webhooks are best-effort by design: a
 * missed webhook costs latency, never data, because the next scheduled run
 * pulls from the cursor regardless.
 */

import { loadConfig, ConfigError, type Config } from "./config.js";
import { log } from "./logger.js";
import { createApp, createWebhookApp } from "./server.js";
import { SyncCoordinator } from "./coordinator.js";
import { PlaidClient } from "./plaid.js";
import { StateStore } from "./state.js";

const MINUTE_MS = 60 * 1000;

/**
 * Validates config up front so a missing variable fails at boot with a clear
 * message, rather than inside the first cycle.
 */
function preflight(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("%s", err.message);
      process.exit(1);
    }
    throw err;
  }
}

function scheduleNext(coordinator: SyncCoordinator, intervalMinutes: number): void {
  log.info("Next scheduled sync in %d minute(s).", intervalMinutes);
  const timer = setInterval(() => {
    coordinator.trigger("timer");
  }, intervalMinutes * MINUTE_MS);
  // Do not hold the process open for the timer alone.
  timer.unref?.();
}

/**
 * Registers `SYNC_UPDATES_AVAILABLE` item webhooks for every linked item.
 *
 * Only Items consumed via `/transactions/sync` emit that event, so this is
 * run for each one. Failures are logged but never fatal: an item without a
 * webhook still syncs on the timer.
 */
async function registerWebhooks(config: Config): Promise<void> {
  if (!config.webhookUrl) return;

  const plaid = new PlaidClient(config);
  const store = new StateStore(config.dataDir);
  await store.load();

  const items = store.listLinkedItems();
  if (items.length === 0) {
    log.info("No linked items yet; skipping webhook registration.");
    return;
  }

  for (const [key, item] of items) {
    if (!item.accessToken) continue;
    try {
      await plaid.addSyncUpdatesWebhook(item.accessToken, config.webhookUrl);
      log.info("Registered webhook for %s.", item.label ?? key);
    } catch (err) {
      log.error(
        "Could not register webhook for %s: %s — it will still sync on the timer.",
        item.label ?? key,
        (err as Error).message,
      );
    }
  }
}

async function main(): Promise<void> {
  const config = preflight();
  const runOnce = process.argv.includes("--once");
  const withServer = process.argv.includes("--with-server");

  // --once exits the process as soon as the first cycle finishes, which would
  // tear down the re-auth server moments after it started. Refuse rather than
  // fail confusingly.
  if (runOnce && withServer) {
    log.error("--once cannot be combined with --with-server; the process would exit immediately.");
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    log.info("Received %s; shutting down.", signal);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log.info(
    "plaid-actual-sync starting (env=%s, interval=%dm, actual=%s, webhooks=%s).",
    config.plaid.env,
    config.sync.intervalMinutes,
    config.actual.enabled ? "configured" : "PLAID-ONLY",
    config.webhookUrl ?? "off",
  );

  if (!config.sync.enabled) {
    log.warn("ENABLED=false; scheduled syncing is disabled.");
  }

  const coordinator = new SyncCoordinator(config);

  if (withServer) {
    const port = Number(process.env.WEB_PORT ?? 8090);
    createApp(config, coordinator).listen(port, "0.0.0.0", () => {
      log.info("Dashboard listener on :%d (public URL %s)", port, config.publicUrl);
    });
  }

  // The webhook gets a SEPARATE listener with a one-route surface, so that
  // funnelling it to the internet does not also publish the dashboard (which
  // can initiate bank logins). Both listeners share one coordinator, so a
  // webhook cannot race the dashboard's "Sync now" button.
  if (config.webhookUrl) {
    const webhookPort = Number(process.env.WEBHOOK_PORT ?? 8091);
    createWebhookApp(config, coordinator).listen(webhookPort, "0.0.0.0", () => {
      log.info("Webhook listener on :%d (funnel THIS port, not %s)", webhookPort, "the dashboard port");
    });
  }

  // Webhook registration needs a fresh StateStore read, so it runs after the
  // coordinator exists but is entirely independent of the first sync.
  void registerWebhooks(config).catch((err) =>
    log.error("Webhook registration failed: %s", (err as Error).message),
  );

  if (runOnce) {
    await coordinator.request("startup");
    log.info("Single-run mode; exiting.");
    coordinator.dispose();
    return;
  }

  // Run once at startup so a restart does not sit idle until the first tick,
  // then let the interval take over.
  coordinator.trigger("startup");
  scheduleNext(coordinator, config.sync.intervalMinutes);

  // Hold the process open: the HTTP server and the interval keep it alive, but
  // both are unref'd, so park here explicitly.
  await new Promise<void>(() => {});
}

void main();