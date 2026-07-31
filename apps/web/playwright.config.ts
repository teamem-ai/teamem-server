import { defineConfig, devices } from "@playwright/test";

/**
 * Full-stack browser acceptance tests for the teamem web UI.
 *
 * These tests require a running server (default http://localhost:8080).
 * Point the server at an empty test database and run with:
 *
 *   pnpm exec playwright install
 *   DATABASE_URL=... pnpm --filter @teamem/web exec playwright test
 *
 * The tests skip gracefully if the server is unreachable, so CI does not
 * fail when no server is running.
 */
export default defineConfig({
  testDir: "./e2e",
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
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
