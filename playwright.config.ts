import { defineConfig, devices } from "@playwright/test";

// #154: browser-level tests run against the BUILT web app served by the real localhost API on port 4319
// (never the stable app on 4310 or dev on 4311/5174), over a temporary synthetic data root.
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4319", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/browser/serve.mjs",
    url: "http://127.0.0.1:4319/api/v1/health",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 120_000
  }
});
