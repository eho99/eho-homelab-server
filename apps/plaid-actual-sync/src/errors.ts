/**
 * Plaid error classification.
 *
 * The sync worker makes a different decision depending on WHY an Item failed:
 * some failures need a human (re-auth), some just need a retry next cycle,
 * and some mean the integration is misconfigured. Treating them all as
 * "log and continue" is what lets a revoked Chase link quietly stop syncing
 * for months.
 *
 * Plaid surfaces these as HTTP errors from the SDK, shaped roughly as:
 *   AxiosError.response.data.error = { error_type, error_code, error_message }
 * so classification has to dig through the Axios envelope.
 */

export type PlaidFailureKind = "reauth" | "transient" | "fatal" | "unknown";

interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
  request_id?: string;
}

/** Codes that mean "the user must re-link this institution". */
const REAUTH_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_ACCESS_TOKEN",
  "ITEM_LOCKED",
]);

/** Codes that are expected to clear on their own within a cycle or two. */
const TRANSIENT_CODES = new Set([
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "RATE_LIMIT_EXCEEDED",
  "INTERNAL_SERVER_ERROR",
  "ITEM_CONCURRENT_UPDATE",
  "REQUEST_NOT_PROCESSED",
  // Plaid is still fetching the initial transaction history. Retrying later is
  // exactly the right response — the data is not missing, just not ready.
  "PRODUCT_NOT_READY",
  "ASSET_REPORT_NOT_READY",
]);

/** Codes that will never succeed without changing credentials or config. */
const FATAL_CODES = new Set([
  "INVALID_API_KEYS",
  "INVALID_CREDENTIALS",
  "INVALID_FIELD",
  "INVALID_PRODUCT",
  "PRODUCTS_NOT_SUPPORTED",
]);

interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

/**
 * Extracts the Plaid error payload from an SDK/Axios rejection, if present.
 *
 * Plaid uses TWO different shapes and it matters which one you read:
 *
 *   - HTTP error responses put the fields at the TOP LEVEL of the body:
 *       { error_type, error_code, error_message, display_message, request_id }
 *   - Webhook payloads NEST them under `.error`:
 *       { webhook_type, error: { error_code, ... } }
 *
 * An earlier version only looked for the nested form. That silently broke
 * EVERYTHING: `needsReauth()` never returned true, so an expired Chase link
 * would fail every cycle and be retried forever instead of being flagged for
 * re-authentication, and every error surfaced to the user was the useless
 * "Request failed with status code 400".
 *
 * Both shapes are checked, top level first.
 */
function extractPlaidError(err: unknown): PlaidErrorBody | undefined {
  const data = (err as { response?: { data?: unknown } }).response?.data as
    | (PlaidErrorBody & { error?: PlaidErrorBody })
    | undefined;

  if (!data) return undefined;

  // HTTP error responses: fields at the top level.
  if (typeof data.error_code === "string" || typeof data.error_type === "string") {
    return data;
  }

  // Webhook payloads: fields nested under `error`.
  if (data.error && (data.error.error_code || data.error.error_type)) {
    return data.error;
  }

  return undefined;
}

export function plaidErrorCode(err: unknown): string | undefined {
  return extractPlaidError(err)?.error_code;
}

/**
 * Decides what the worker should do about a failure.
 *
 * Note `ITEM_LOCKED` is grouped with re-auth: it means an update-mode session
 * is currently in flight for this Item, which is a transient state during
 * re-auth rather than a genuine credential problem. It is separated out at
 * the call site so an in-progress re-link is not reported as "needs login".
 */
export function classifyPlaidError(err: unknown): PlaidFailureKind {
  const code = plaidErrorCode(err);
  if (!code) return "unknown";
  if (REAUTH_CODES.has(code)) return "reauth";
  if (TRANSIENT_CODES.has(code)) return "transient";
  if (FATAL_CODES.has(code)) return "fatal";
  return "unknown";
}

/** Human-readable message, preferring Plaid's own display text when present. */
export function describePlaidError(err: unknown): string {
  const body = extractPlaidError(err);
  if (body?.display_message) return body.display_message;
  if (body?.error_message) return body.error_message;
  if (body?.error_code) return `Plaid error ${body.error_code}`;
  return err instanceof Error ? err.message : String(err);
}

/** True when the Item's OAuth grant has lapsed and needs the update-mode UI. */
export function needsReauth(err: unknown): boolean {
  return plaidErrorCode(err) === "ITEM_LOGIN_REQUIRED";
}