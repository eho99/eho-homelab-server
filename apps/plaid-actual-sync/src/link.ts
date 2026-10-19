/**
 * One-time onboarding: connect a bank account and store its Plaid access token.
 *
 * Run this manually — it is interactive and not part of the scheduled worker:
 *
 *   npm run link
 *
 * Why this exists at all: a Plaid access token is only ever handed out by the
 * public-token exchange below. There is no endpoint to look one up later, so
 * if this step is skipped the worker has nothing to sync with. The token then
 * lives in the gitignored state file on the `/data` volume.
 */

import { createServer } from "node:http";
import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { PlaidClient } from "./plaid.js";
import { StateStore } from "./state.js";

/**
 * Must be registered as an allowed redirect URI on your Plaid dashboard.
 *
 * NOTE: Plaid requires redirect URIs to be HTTPS, with ONE exception — in
 * Sandbox, `http://localhost` is allowed over plain HTTP. That is why this
 * CLI flow works during development but will be rejected in production,
 * where re-authentication must go through the web page instead (see
 * server.ts, which uses PUBLIC_URL).
 */
const CALLBACK_PORT = Number(process.env.LINK_CALLBACK_PORT ?? 5180);
const CALLBACK_PATH = "/callback";

/** How long to wait for the user to finish the Link flow. */
const TIMEOUT_MS = 5 * 60 * 1000;

function waitForPublicToken(redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Plaid Link to complete."));
    }, TIMEOUT_MS);

    const server = createServer((req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, redirectUri);
      const publicToken = url.searchParams.get("public_token");
      const error = url.searchParams.get("error");

      clearTimeout(timer);
      server.close();

      if (error) {
        res
          .writeHead(400, { "content-type": "text/plain" })
          .end(`Plaid Link failed: ${url.searchParams.get("error_description") ?? error}`);
        reject(new Error(`Plaid Link failed: ${error}`));
        return;
      }
      if (!publicToken) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Missing public_token.");
        reject(new Error("Plaid did not return a public_token."));
        return;
      }

      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          "<html><body style='font-family:system-ui;padding:2rem'>" +
            "<h2>Account connected.</h2>" +
            "<p>You can close this tab and return to your terminal.</p>" +
            "</body></html>",
        );
      resolve(publicToken);
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      log.info("Listening for the Link callback on %s", redirectUri);
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not listen on port ${CALLBACK_PORT}: ${err.message}. ` +
            `Set LINK_CALLBACK_PORT to a free port, and make sure ` +
            `${CALLBACK_PATH} is registered as a redirect URI on your Plaid dashboard.`,
        ),
      );
    });
  });
}

/** Opens a URL in the user's default browser, failing softly if we can't. */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? `open ${JSON.stringify(url)}`
      : process.platform === "win32"
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;

  exec(command, (err) => {
    if (err) {
      log.warn("Could not open a browser automatically (%s).", err.message);
      log.warn("Open this URL manually: %s", url);
    }
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const plaid = new PlaidClient(config);
  const store = new StateStore(config.dataDir);
  await store.load();

  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const linkToken = await plaid.createLinkToken(redirectUri);
  const linkUrl = `https://plaid.com/link/?token=${encodeURIComponent(linkToken)}`;

  log.info("Open this URL to connect a bank account:");
  log.info("");
  log.info("  %s", linkUrl);
  log.info("");
  log.info("Opening your browser automatically...");

  // Start listening before opening the browser, so a fast completion cannot
  // race the server coming up.
  const publicTokenPromise = waitForPublicToken(redirectUri);
  openInBrowser(linkUrl);

  const publicToken = await publicTokenPromise;

  const accessToken = await plaid.exchangePublicToken(publicToken);
  const item = await plaid.getItem(accessToken);
  const accounts = await plaid.listAccounts(accessToken);

  store.addItem(accessToken, item.itemId, item.institutionName);
  await store.save();

  log.info("");
  log.info("Connected %s with %d account(s).", item.institutionName, accounts.length);
  for (const account of accounts) {
    log.info("  - %s (%s)", account.name, account.mask ? `****${account.mask}` : "no mask");
  }
  log.info("");
  log.info("Stored in %s. Run a sync with: npm run sync:once", config.dataDir);
}

void main().catch((err) => {
  log.error("%s", (err as Error).message);
  process.exit(1);
});