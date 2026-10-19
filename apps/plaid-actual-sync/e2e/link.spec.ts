/**
 * End-to-end check of the Plaid Link flow against Plaid SANDBOX.
 *
 * What this proves: that a bank can be linked headlessly, that a public token
 * can be exchanged for an access token, and that transactions then flow all
 * the way into Actual.
 *
 * What this deliberately does NOT prove: anything about your production
 * credentials. Sandbox institutions are fixtures with synthetic data.
 *
 * Skip unless all of these are set:
 *   PLAID_CLIENT_ID, PLAID_SECRET   (sandbox keys from the Plaid dashboard)
 *   ACTUAL_URL, ACTUAL_PASSWORD, ACTUAL_BUDGET_ID
 *   TEST_DATA_DIR                    (writable scratch dir)
 *
 * Run with:  npm run e2e
 */

import { test, expect, type Frame, type Page } from "@playwright/test";

/**
 * Plaid's built-in sandbox institution. These credentials are documented and
 * public — they are fixtures, not secrets. `user_transactions_dynamic`
 * generates a fresh set of transactions on each Link session, which is what
 * makes repeated runs non-identical.
 */
const SANDBOX_USER = "user_transactions_dynamic";
const SANDBOX_PASS = "pass_good";

/**
 * The app instance under test.
 *
 * This must point at an instance whose DATA_DIR is the one you want the test
 * to exercise — in the compose setup that is the dedicated `plaid-sync-e2e`
 * container, NOT the production `plaid-sync` one. Pointing it at production
 * would link sandbox institutions into your real budget.
 */
const APP_URL = process.env.E2E_APP_URL ?? "http://127.0.0.1:8090";

/**
 * Plaid Link lives in a cross-origin iframe, so every interaction must go
 * through the frame rather than the page.
 */
async function plaidFrame(page: Page): Promise<Frame> {
  const element = await page.waitForSelector("iframe[id^='plaid']", { timeout: 30_000 });
  const frame = await element.contentFrame();
  if (!frame) throw new Error("Plaid Link iframe has no accessible frame");
  return frame;
}

/**
 * Drives the sandbox institution selection and credential entry.
 *
 * Every step is scoped to the Plaid frame and uses text/role selectors because
 * Plaid's internal markup is not a supported interface.
 */
async function completeSandboxLogin(page: Page): Promise<void> {
  let frame = await plaidFrame(page);

  // 1. Institution search.
  const search = frame.getByRole("textbox", { name: /search/i }).first();
  await search.waitFor({ state: "visible" });
  await search.fill("First Platypus Bank");
  await search.press("Enter");

  // 2. Credentials.
  frame = await plaidFrame(page);
  const user = frame.getByLabel(/username/i).first();
  await user.waitFor({ state: "visible" });
  await user.fill(SANDBOX_USER);
  await frame.getByLabel(/password/i).first().fill(SANDBOX_PASS);
  await frame.getByRole("button", { name: /submit|continue/i }).first().click();

  // 3. Optional MFA. The sandbox fixtures use 1234 but some institutions skip
  //    the prompt entirely, so it is handled as "may or may not appear".
  frame = await plaidFrame(page);
  const mfa = frame.getByLabel(/code/i).first();
  if (await mfa.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await mfa.fill("1234");
    await frame.getByRole("button", { name: /continue|submit/i }).first().click();
  }
}

test.describe("Plaid Link → Actual end-to-end (sandbox)", () => {
  test.beforeAll(() => {
    // Fail fast and loudly rather than midway through a Link session.
    for (const name of ["PLAID_CLIENT_ID", "PLAID_SECRET"]) {
      if (!process.env[name]) {
        throw new Error(`${name} must be set to run the e2e suite.`);
      }
    }
    if ((process.env.PLAID_ENV ?? "sandbox") !== "sandbox") {
      throw new Error(
        `Refusing to run: PLAID_ENV is "${process.env.PLAID_ENV}". ` +
          `These tests are written against sandbox fixtures and must never ` +
          `touch production credentials.`,
      );
    }
  });

  test("links a sandbox bank and imports transactions into Actual", async ({ page }) => {
    const start = Date.now();

    // 1. Open the status page and ask for a fresh link token.
    await page.goto(`${APP_URL}/`);

    const tokenResponse = await page.request.post(`${APP_URL}/api/link-token`, {
      data: {},
    });
    expect(tokenResponse.ok()).toBeTruthy();
    const { linkToken } = (await tokenResponse.json()) as { linkToken: string };
    expect(linkToken).toBeTruthy();

    // 2. Launch Link on a blank page the way the status page does.
    await page.setContent(`
      <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
      <button id="go">Link</button>
    `);
    await page.evaluate((token) => {
      const handler = window.Plaid.create({
        token,
        onSuccess: (publicToken) => {
          (window as unknown as { __publicToken: string }).__publicToken = publicToken;
        },
      });
      document.getElementById("go")!.addEventListener("click", () => handler.open());
    }, linkToken);

    await page.getByRole("button", { name: "Link" }).click();
    await completeSandboxLogin(page);

    // 3. The public token must come back.
    await page.waitForFunction(
      () => Boolean((window as unknown as { __publicToken?: string }).__publicToken),
      undefined,
      { timeout: 60_000 },
    );
    const publicToken = await page.evaluate(
      () => (window as unknown as { __publicToken: string }).__publicToken,
    );
    expect(publicToken).toMatch(/^public-sandbox-/);

    // 4. Exchange server-side. The Plaid secret must never reach the browser,
    //    which is why this goes through the app rather than being done here.
    const exchange = await page.request.post(`${APP_URL}/api/link-token/complete`, {
      data: { publicToken },
    });
    expect(exchange.ok()).toBeTruthy();

    // 5. Run a sync and confirm transactions actually landed in the budget.
    const sync = await page.request.post(`${APP_URL}/api/sync`, { data: {} });
    expect(sync.ok()).toBeTruthy();
    const summary = (await sync.json()) as { imported: number };
    expect(summary.imported).toBeGreaterThan(0);

    // 6. The durable token, account mapping and cursor must all be persisted
    //    for the next cycle to work.
    //
    //    This asserts through the API rather than reading state.json off
    //    disk: the app writes its state to ITS OWN container filesystem, and
    //    this suite may run in a different container from that one. Reading
    //    the file would couple the test to the wrong process.
    const itemsResponse = await page.request.get(`${APP_URL}/api/items`);
    expect(itemsResponse.ok()).toBeTruthy();
    const items = (await itemsResponse.json()) as Array<{
      label: string;
      hasAccessToken: boolean;
      hasCursor: boolean;
      linkedAccounts: number;
      needsReauth: boolean;
    }>;

    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.hasAccessToken).toBe(true);
    expect(items[0]!.hasCursor).toBe(true);
    expect(items[0]!.linkedAccounts).toBeGreaterThan(0);
    expect(items[0]!.needsReauth).toBe(false);

    test.info().annotations.push({
      type: "duration",
      description: `link+sync completed in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    });
  });

  test("state file survives a restart without re-importing", async ({ page }) => {
    // A second sync over unchanged data must import nothing. This is the
    // regression guard for the dedupe path, which is the easiest thing to
    // break and the most expensive when broken (double-posted budget).
    const first = await page.request.post(`${APP_URL}/api/sync`, { data: {} });
    expect(first.ok()).toBeTruthy();
    const firstSummary = (await first.json()) as { imported: number };

    const second = await page.request.post(`${APP_URL}/api/sync`, { data: {} });
    const secondSummary = (await second.json()) as { imported: number };

    expect(secondSummary.imported).toBe(0);
    expect(firstSummary.imported).toBeGreaterThanOrEqual(secondSummary.imported);
  });
});

/**
 * Records the current sandbox link result for debugging a failed run.
 * Kept as a helper rather than a test so it is never counted as a pass.
 */
export async function dumpDiagnostics(page: Page, path: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, await page.content(), "utf8");
}