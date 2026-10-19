/**
 * Plaid webhook handling.
 *
 * WHAT WEBHOOKS ARE FOR HERE: the scheduled poll remains the backbone. Plaid
 * guarantees nothing about webhook timing, and a webhook is only a hint that
 * "something changed, come look". So a missed webhook costs latency, never
 * correctness. Every sync path is still the same idempotent, cursor-driven
 * routine the timer uses.
 *
 * THE IMPORTANT DETAIL — and the one most integrations get wrong:
 *
 * Because this app syncs via `/transactions/sync`, Plaid does NOT send the
 * `DEFAULT_UPDATE` / `INITIAL_UPDATE` / `HISTORICAL_UPDATE` transaction
 * webhooks for those Items. Those only fire for Items on the legacy
 * `/transactions/get` flow. Instead you get an ITEM webhook:
 *
 *     SYNC_UPDATES_AVAILABLE
 *
 * which carries NO transaction data at all — just a request_id telling you to
 * call `/item/webhook/sync_updates/get` to see what changed. Handlers written
 * from the transaction-webhook documentation will appear to work while
 * silently never syncing anything.
 *
 * SECURITY: any host that can reach this endpoint can otherwise make us sync
 * on demand. Every request is verified against Plaid's signed JWT.
 */

import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { log } from "./logger.js";

/** Plaid's JWTs are ES256 (ECDSA P-256). */
interface PlaidJwk {
  key_id: string;
  alg: string;
  crv: string;
  x: string;
  y: string;
  use: string;
  created: number;
  // Node's JWK type requires an index signature; Plaid's key is a valid JWK.
  [prop: string]: unknown;
}

interface PlaidVerificationClaims {
  iat: number;
  request_body_sha256: string;
  request_id: string;
  key_id: string;
}

/** Reject a webhook whose JWT is older than this. */
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export type VerificationResult =
  | { ok: true; requestId: string }
  | { ok: false; reason: string };

/**
 * Verifies the `Plaid-Verification` JWT header against the request body.
 *
 * Three checks, all required:
 *   1. the signature verifies against the key Plaid identifies by `key_id`
 *   2. `request_body_sha256` matches the exact raw bytes received
 *   3. `iat` is recent enough to resist replay
 *
 * The body check is why the raw buffer is required — re-serialising the parsed
 * JSON changes key order and whitespace, and the hash would never match.
 */
export async function verifyWebhook(
  config: Config,
  header: string | undefined,
  rawBody: Buffer,
): Promise<VerificationResult> {
  if (!header) return { ok: false, reason: "missing Plaid-Verification header" };

  const parts = header.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT" };

  const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] = parts;

  let claims: PlaidVerificationClaims;
  let jwtHeader: { alg?: string; kid?: string };
  try {
    claims = JSON.parse(base64UrlToBuffer(encodedClaims).toString("utf8")) as PlaidVerificationClaims;
    jwtHeader = JSON.parse(base64UrlToBuffer(encodedHeader).toString("utf8")) as { alg?: string; kid?: string };
  } catch {
    return { ok: false, reason: "unparseable JWT payload" };
  }

  if (jwtHeader.alg !== "ES256") {
    // Pinning the algorithm is what prevents the classic "alg: none" and
    // HMAC-confusion downgrades.
    return { ok: false, reason: `unexpected alg "${jwtHeader.alg}"` };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - claims.iat);
  if (!Number.isFinite(claims.iat) || age > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: `stale token (${age}s old)` };
  }

  // Check the body binding BEFORE hitting the network, so a forged request is
  // rejected cheaply.
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (
    typeof claims.request_body_sha256 !== "string" ||
    !safeEqual(bodyHash, claims.request_body_sha256)
  ) {
    return { ok: false, reason: "body hash mismatch" };
  }

  let jwk: PlaidJwk;
  try {
    if (!claims.key_id) return { ok: false, reason: "JWT has no key_id" };
    jwk = await fetchVerificationKey(config, claims.key_id);
  } catch (err) {
    return { ok: false, reason: `could not fetch verification key: ${(err as Error).message}` };
  }

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });

  // Node THROWS on a structurally invalid signature rather than returning
  // false. Without this guard a malformed `Plaid-Verification` header would
  // reject as an unhandled exception and take the process down — i.e. anyone
  // who can reach the endpoint could crash the worker with a garbage header.
  let valid: boolean;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(`${encodedHeader}.${encodedClaims}`);
    verifier.end();
    valid = verifier.verify(
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      base64UrlToBuffer(encodedSignature),
    );
  } catch (err) {
    return { ok: false, reason: `signature is malformed: ${(err as Error).message}` };
  }

  if (!valid) return { ok: false, reason: "bad signature" };

  return { ok: true, requestId: claims.request_id };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Fetches Plaid's signing key, caching it.
 *
 * Cached because this runs on every webhook. Plaid rotates keys rarely, and
 * re-fetching per request would add latency to a path that must answer fast.
 */
let cachedKey: { keyId: string; jwk: PlaidJwk; fetchedAt: number } | null = null;
const KEY_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchVerificationKey(config: Config, keyId: string): Promise<PlaidJwk> {
  if (cachedKey && cachedKey.keyId === keyId && Date.now() - cachedKey.fetchedAt < KEY_TTL_MS) {
    return cachedKey.jwk;
  }

  const base =
    config.plaid.env === "production"
      ? "https://production.plaid.com"
      : config.plaid.env === "development"
        ? "https://development.plaid.com"
        : "https://sandbox.plaid.com";

  const response = await fetch(`${base}/webhook_verification_key/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.plaid.clientId,
      secret: config.plaid.secret,
      key_id: keyId,
    }),
  });

  if (!response.ok) {
    throw new Error(`verification key endpoint returned ${response.status}`);
  }

  const data = (await response.json()) as { key: PlaidJwk };
  if (!data?.key?.key_id) throw new Error("verification key response had no key");

  cachedKey = { keyId: data.key.key_id, jwk: data.key, fetchedAt: Date.now() };
  return data.key;
}

/** Test seam: drop the cached verification key. */
export function clearKeyCache(): void {
  cachedKey = null;
}

/** Webhook payload shapes this app understands. */
export type WebhookEvent =
  | { type: "SYNC_UPDATES_AVAILABLE"; requestId: string }
  | { type: "ITEM_ERROR"; itemId: string; errorCode: string }
  | { type: "DEFAULT_UPDATE"; itemId: string }
  | { type: "INITIAL_UPDATE"; itemId: string }
  | { type: "HISTORICAL_UPDATE"; itemId: string }
  | { type: "TRANSACTIONS_REMOVED"; itemId: string }
  | { type: "PENDING_EXPIRATION"; itemId: string }
  | { type: "UNKNOWN"; webhookType: string };

/**
 * Classifies a webhook body.
 *
 * Handles both the flat transaction-webhook shape and the item-webhook shape,
 * because an Item registered for `SYNC_UPDATES_AVAILABLE` can also emit
 * `ERROR` and `PENDING_EXPIRATION`.
 */
export function classifyWebhook(body: unknown): WebhookEvent {
  const b = body as {
    webhook_type?: string;
    webhook_code?: string;
    item_id?: string;
    error?: { error_code?: string };
  } | null;

  if (!b || typeof b !== "object") return { type: "UNKNOWN", webhookType: "?" };

  const type = b.webhook_type ?? "";

  // ERROR is sent for both shapes; the error body is nested here.
  if (type === "ERROR") {
    return {
      type: "ITEM_ERROR",
      itemId: b.item_id ?? "",
      errorCode: b.error?.error_code ?? "UNKNOWN",
    };
  }

  if (type === "SYNC_UPDATES_AVAILABLE") {
    return { type: "SYNC_UPDATES_AVAILABLE", requestId: "" };
  }

  if (type === "PENDING_EXPIRATION") {
    return { type: "PENDING_EXPIRATION", itemId: b.item_id ?? "" };
  }

  switch (type) {
    case "TRANSACTIONS":
      switch (b.webhook_code) {
        case "DEFAULT_UPDATE":
          return { type: "DEFAULT_UPDATE", itemId: b.item_id ?? "" };
        case "INITIAL_UPDATE":
          return { type: "INITIAL_UPDATE", itemId: b.item_id ?? "" };
        case "HISTORICAL_UPDATE":
          return { type: "HISTORICAL_UPDATE", itemId: b.item_id ?? "" };
        case "TRANSACTIONS_REMOVED":
          return { type: "TRANSACTIONS_REMOVED", itemId: b.item_id ?? "" };
        default:
          return { type: "UNKNOWN", webhookType: `TRANSACTIONS:${b.webhook_code ?? "?"}` };
      }
    default:
      return { type: "UNKNOWN", webhookType: type };
  }
}

/**
 * Whether this event should cause a sync.
 *
 * Note that SYNC_UPDATES_AVAILABLE is a bare signal — the actual changes are
 * fetched separately via /item/webhook/sync_updates/get, which the sync loop
 * does implicitly by pulling from the cursor.
 */
export function shouldTriggerSync(event: WebhookEvent): boolean {
  switch (event.type) {
    case "SYNC_UPDATES_AVAILABLE":
    case "DEFAULT_UPDATE":
    case "INITIAL_UPDATE":
    case "HISTORICAL_UPDATE":
    case "TRANSACTIONS_REMOVED":
    case "ITEM_ERROR":
    case "PENDING_EXPIRATION":
      return true;
    case "UNKNOWN":
      return false;
  }
}

export function describeWebhook(event: WebhookEvent): string {
  if (event.type === "UNKNOWN") return `unhandled webhook type "${event.webhookType}"`;
  if (event.type === "SYNC_UPDATES_AVAILABLE") return "sync updates available";
  if (event.type === "ITEM_ERROR") return `item error: ${event.errorCode}`;
  return `${event.type} for item ${event.itemId || "(unknown)"}`;
}