import { test, expect } from "@playwright/test";

const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";
const sessionCookie = process.env["E2E_SESSION_COOKIE"];

interface AuthMe {
  user: { id: string; githubLogin: string };
  teams: Array<{ id: string; name: string; role: string }>;
  currentTeam?: { id: string; name: string; role: string };
}

async function getAuthMe(cookie: string): Promise<AuthMe | null> {
  try {
    const res = await fetch(`${baseURL}/auth/me`, {
      headers: { Cookie: `teamem_session=${cookie}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()).data as AuthMe;
  } catch {
    return null;
  }
}

/**
 * Skip full-stack browser tests when no server is reachable OR no valid
 * session cookie is provided. These tests need a real server, database, and
 * an authenticated admin/owner session.
 *
 * Set up locally:
 *   1. Start the server with a test database.
 *   2. Log in via GitHub to get a real session cookie.
 *   3. Run: E2E_SESSION_COOKIE=<value> pnpm --filter @teamem/web exec playwright test
 */
test.beforeEach(async ({ page, context }) => {
  const reachable = await (async () => {
    try {
      const res = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  })();

  if (!reachable || !sessionCookie) {
    test.skip(
      true,
      "E2E server is not reachable or E2E_SESSION_COOKIE is missing. See settings.spec.ts for setup.",
    );
    return;
  }

  const auth = await getAuthMe(sessionCookie);
  if (!auth?.user) {
    test.skip(true, "E2E_SESSION_COOKIE is not a valid teamem session.");
    return;
  }

  await context.addCookies([
    {
      name: "teamem_session",
      value: sessionCookie,
      domain: new URL(baseURL).hostname,
      path: "/",
    },
  ]);

  // Expose the current team id to the page for use in selectors.
  await page.evaluate((teamId) => {
    (window as unknown as { __teamId?: string }).__teamId = teamId;
  }, auth.currentTeam?.id ?? auth.teams[0]?.id);
});

test.describe("Settings area — full-stack browser acceptance", () => {
  test("minted key plaintext is not shown after page refresh", async ({ page }) => {
    await page.goto(`${baseURL}/settings/keys`);
    await page.waitForURL("**/settings/keys");

    // Open the mint modal.
    await page.getByRole("button", { name: "Mint API key" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Fill the form and mint.
    await page.locator("#kname").fill("E2E Test Key");
    await page.locator("#kproj").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Mint key" }).click();

    // The one-time token should appear in the reveal modal.
    const tokenLocator = page.getByTestId("key-token");
    await expect(tokenLocator).toBeVisible();
    const token = await tokenLocator.textContent();
    expect(token).toMatch(/^tm_/);
    expect(token!.length).toBeGreaterThan(20);

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.reload();

    // After refresh the token must NOT be visible in the page.
    await expect(page.locator(`text=${token}`)).not.toBeVisible();
  });

  test("purge confirmation is disabled until the correct project name is typed", async ({ page }) => {
    await page.goto(`${baseURL}/settings/project`);
    await page.waitForURL("**/settings/project");

    // Read the project name from the danger zone text.
    const dangerZone = page.locator(".card").filter({ has: page.getByText("Danger zone") });
    const text = await dangerZone.getByText(/Delete all events/).textContent();
    const match = text?.match(/in\s+(.+?)\.\s/);
    const projectName = match?.[1]?.trim() ?? "Test Project";

    await dangerZone.getByRole("button", { name: "Purge" }).click();
    const confirm = page.getByRole("button", { name: "Purge project data" });
    await expect(confirm).toBeDisabled();

    // Type a wrong name.
    await page.locator("input.mono").fill("wrong name");
    await expect(confirm).toBeDisabled();

    // Type the correct name.
    await page.locator("input.mono").fill(projectName);
    await expect(confirm).toBeEnabled();
  });
});
