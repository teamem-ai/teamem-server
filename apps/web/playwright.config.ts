import { defineConfig, devices } from "@playwright/test";

/**
 * Full-stack browser acceptance tests for the teamem web UI.
 *
 * These tests require a running server (default http://localhost:8080) with
 * the E2E setup route enabled. Start the server with:
 *
 *   TEAMEM_E2E_SECRET=dev-secret pnpm --filter @teamem/server dev
 *
 * Then run the E2E suite:
 *
 *   TEAMEM_E2E_SECRET=dev-secret pnpm --filter @teamem/web exec playwright test
 *
 * Install browsers first:
 *   pnpm --filter @teamem/web exec playwright install
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:8080",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "owner",
      grep: /@owner/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "./e2e/.auth/owner.json",
      },
    },
    {
      name: "viewer",
      grep: /@viewer/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "./e2e/.auth/viewer.json",
      },
    },
  ],
});
