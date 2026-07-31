import { test, expect } from "@playwright/test";

const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

/**
 * Skip full-stack browser tests when no server is reachable.
 * These tests require a real server + database + authenticated session.
 */
async function serverIsReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  const reachable = await serverIsReachable();
  if (!reachable) {
    test.skip(true, "E2E server is not reachable; set E2E_BASE_URL and start the server.");
  }
  // Authenticate via a test-only cookie when the server exposes it.
  // Real GitHub OAuth flow is not exercised in automated E2E.
  const testSession = process.env["E2E_SESSION_COOKIE"];
  if (testSession) {
    await page.context().addCookies([
      {
        name: "teamem_session",
        value: testSession,
        domain: new URL(baseURL).hostname,
        path: "/",
      },
    ]);
  }
});

test.describe("Settings area — full-stack browser acceptance", () => {
  test("viewer role hides management actions", async ({ page }) => {
    await page.goto(`${baseURL}/settings/keys`);
    await expect(page.locator("text=API keys")).toBeVisible();
    // Management actions should not be present for a viewer session.
    await expect(page.locator("button:has-text('Mint key')")).not.toBeVisible();
  });

  test("minted key plaintext is not shown after page refresh", async ({ page }) => {
    await page.goto(`${baseURL}/settings/keys`);
    await page.click("button:has-text('Mint key')");
    await page.fill("input[name='name']", "E2E Test Key");
    await page.click("button:has-text('Mint key')");

    // The one-time token should appear in the reveal modal.
    const token = await page.locator("[data-testid='key-token']").textContent();
    expect(token).toMatch(/^tm_/);
    expect(token!.length).toBeGreaterThan(20);

    await page.click("button:has-text(\"Done\")");
    await page.reload();

    // After refresh the token must NOT be visible in the page.
    await expect(page.locator(`text=${token}`)).not.toBeVisible();
  });

  test("purge confirmation is disabled until the correct project name is typed", async ({ page }) => {
    await page.goto(`${baseURL}/settings/project`);
    await page.click("button:has-text('Purge')");
    const confirm = page.locator("button:has-text('Purge project data')");
    await expect(confirm).toBeDisabled();

    await page.fill("input[placeholder='project name']", "wrong name");
    await expect(confirm).toBeDisabled();

    await page.fill("input[placeholder='project name']", "Test Project");
    await expect(confirm).toBeEnabled();
  });
});
