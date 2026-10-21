/**
 * Environment parsing and validation.
 *
 * Every setting the worker needs is read here exactly once so that a typo in
 * a variable name fails immediately at startup rather than halfway through a
 * sync, with a partially-written state file.
 */

export interface Config {
  plaid: {
    clientId: string;
    secret: string;
    env: "sandbox" | "production" | "development";
  };
  actual: ActualConfig;
  sync: {
    intervalMinutes: number;
    initialSyncDays: number;
    investmentWindowDays: number;
    deleteRemoved: boolean;
    enabled: boolean;
    autoCategorize: boolean;
    categoryGroupName: string;
  };
  dataDir: string;
  /**
   * Public HTTPS base URL that Plaid can POST webhooks to.
   *
   * Optional: with it unset the app is purely poll-driven, which is a complete
   * and supported mode. Webhooks only make syncs happen sooner.
   *
   * Kept as a plain env var with no coupling to any particular tunnel or host
   * so this can move between machines without code changes.
   */
  webhookUrl?: string;
  /**
   * Minimum seconds between webhook-triggered syncs.
   *
   * Plaid fires a burst of webhooks when an institution has a busy day, and
   * each one costs a full sync. This coalesces them.
   */
  webhookDebounceSeconds: number;
  /**
   * Base URL this service is reached at from a browser. Used to build the
   * Plaid redirect URI, which Plaid requires to match a registered value
   * exactly. Inside Docker this is the Caddy route, not the container URL.
   */
  publicUrl: string;
}

/**
 * Actual Budget connection settings.
 *
 * These are OPTIONAL so the dashboard can be used to link banks and inspect
 * raw Plaid data before Actual exists in the picture. `enabled` is the single
 * source of truth for "should we talk to Actual at all", and every code path
 * that writes to Actual must check it first.
 */
export interface ActualConfig {
  enabled: boolean;
  url?: string;
  password?: string;
  budgetId?: string;
  e2ePassword?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing required environment variable ${name}. ` +
        `See .env.example for the full list of required settings.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${raw}".`);
}

export function loadConfig(): Config {
  const plaidEnv = (optional("PLAID_ENV") ?? "sandbox").toLowerCase();
  if (!["sandbox", "production", "development"].includes(plaidEnv)) {
    throw new ConfigError(
      `PLAID_ENV must be one of sandbox, production, development — got "${plaidEnv}".`,
    );
  }

  const url = optional("ACTUAL_URL");
  const password = optional("ACTUAL_PASSWORD");
  const budgetId = optional("ACTUAL_BUDGET_ID");

  // All-or-nothing. Accepting a partial configuration would produce a
  // confusing failure deep inside the Actual client instead of a clear
  // message here — and would silently disable syncing when, say, only
  // ACTUAL_URL had been filled in.
  const supplied = [
    ["ACTUAL_URL", url],
    ["ACTUAL_PASSWORD", password],
    ["ACTUAL_BUDGET_ID", budgetId],
  ].filter(([, value]) => value !== undefined);

  if (supplied.length > 0 && supplied.length < 3) {
    const names = supplied.map(([name]) => name).join(", ");
    const missing = ["ACTUAL_URL", "ACTUAL_PASSWORD", "ACTUAL_BUDGET_ID"]
      .filter((name) => !supplied.some(([n]) => n === name))
      .join(", ");
    throw new ConfigError(
      `Incomplete Actual configuration: you set ${names} but not ${missing}. ` +
        `Set all three, or remove them all to run in Plaid-only mode.`,
    );
  }

  const actualEnabled = supplied.length === 3;

  if (actualEnabled && url) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new ConfigError(`ACTUAL_URL is not a valid URL: "${url}".`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new ConfigError(`ACTUAL_URL must be http or https, got "${parsedUrl.protocol}".`);
    }
  }

  return {
    plaid: {
      clientId: required("PLAID_CLIENT_ID"),
      secret: required("PLAID_SECRET"),
      env: plaidEnv as Config["plaid"]["env"],
    },
    actual: {
      enabled: actualEnabled,
      ...(actualEnabled ? { url, password, budgetId } : {}),
      e2ePassword: optional("ACTUAL_EE_PASSWORD"),
    },
    sync: {
      intervalMinutes: positiveInt("SYNC_INTERVAL_MINUTES", 360),
      initialSyncDays: positiveInt("INITIAL_SYNC_DAYS", 90),
      // Plaid's /investments/* endpoints are date-ranged with no cursor, so
      // every cycle re-reads this window and dedupes via imported_id.
      investmentWindowDays: positiveInt("INVESTMENT_WINDOW_DAYS", 30),
      deleteRemoved: boolean("DELETE_REMOVED_TRANSACTIONS", true),
      enabled: boolean("ENABLED", true),
      autoCategorize: boolean("AUTO_CATEGORIZE", true),
      categoryGroupName: optional("CATEGORY_GROUP_NAME") ?? "Plaid",
    },
    dataDir: optional("DATA_DIR") ?? "/data",
    // Must match the Caddy route for this service (see caddy/Caddyfile).
    publicUrl: optional("PUBLIC_URL") ?? "https://localhost:9444",
    // Accept either a bare origin (we append /webhook) or a full webhook URL.
    webhookUrl: normaliseWebhookUrl(optional("PLAID_WEBHOOK_URL")),
    webhookDebounceSeconds: positiveInt("WEBHOOK_DEBOUNCE_SECONDS", 300),
  };
}

/**
 * Normalises `PLAID_WEBHOOK_URL` to a full `/webhook` URL.
 *
 * Plaid stores exactly what it is given, so it is easy to end up registering
 * the bare origin and receiving every POST as a 404. Normalising here keeps
 * the registered URL and the served path in agreement.
 */
function normaliseWebhookUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(
      `PLAID_WEBHOOK_URL is not a valid URL: "${raw}". ` +
        `Use e.g. https://your-host.example/webhook`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError(
      `PLAID_WEBHOOK_URL must use https (got "${parsed.protocol}"). ` +
        `Plaid will not deliver webhooks over plain HTTP.`,
    );
  }

  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/webhook";
  }
  return parsed.toString();
}