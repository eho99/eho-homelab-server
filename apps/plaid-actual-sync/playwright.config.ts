import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Plaid Link end-to-end check.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN — Plaid actively discourages
 * automating Link, and the sandbox UI is not a stable contract:
 *
 *  - Plaid Link renders inside a CROSS-ORIGIN iframe served by Plaid's own
 *    CDN. Playwright can only reach it because it attaches to the iframe's
 *    frame object; any markup change on Plaid's side breaks these selectors
 *    without warning.
 *  - Selectors below are intentionally tolerant (role- and text-based) for
 *    that reason. Do not "tidy" them into brittle CSS paths.
 *  - A failure here does NOT necessarily mean the integration is broken; it
 *    may mean Plaid moved a button. Re-run the non-browser tests
 *    (`npm run typecheck`) to separate the two.
 *
 * These tests talk to Plaid SANDBOX only and require the matching sandbox
 * credentials in the environment.
 */
export default defineConfig({
  testDir: "./e2e",
  // Plaid rate-limits aggressively; a retry loop would make failures slower
  // to diagnose without making them more likely to pass.
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});