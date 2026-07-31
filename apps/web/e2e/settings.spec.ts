import { test, expect } from "@playwright/test";

const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";
const hasE2eSecret = Boolean(process.env["TEAMEM_E2E_SECRET"]);

/**
 * E2E settings-area acceptance tests.
 *
 * These tests run against the real server and real browser. Authentication
 * is handled by the global setup (apps/web/e2e/setup.ts), which creates
 * owner and viewer sessions via the guarded /__e2e/setup endpoint.
 *
 * Required environment:
 *   TEAMEM_E2E_SECRET=dev-secret
 */

test.skip(
  !hasE2eSecret,
  "Set TEAMEM_E2E_SECRET and start the server with the E2E setup route enabled.",
);

test.describe("Settings area — owner flows @owner", () => {
  test("minted key plaintext is not shown after page refresh", async ({ page }) => {
    await page.goto(`${baseURL}/settings/keys`);
    await page.waitForURL("**/settings/keys");

    await page.getByRole("button", { name: "Mint API key" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.locator("#kname").fill("E2E Test Key");
    await page.locator("#kproj").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Mint key" }).click();

    const tokenLocator = page.getByTestId("key-token");
    await expect(tokenLocator).toBeVisible();
    const token = await tokenLocator.textContent();
    expect(token).toMatch(/^tm_/);
    expect(token!.length).toBeGreaterThan(20);

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.reload();

    await expect(page.locator(`text=${token}`)).not.toBeVisible();
  });

  test("purge confirmation is disabled until the correct project name is typed", async ({ page }) => {
    await page.goto(`${baseURL}/settings/project`);
    await page.waitForURL("**/settings/project");

    const dangerZone = page.locator(".card").filter({ has: page.getByText("Danger zone") });
    const text = await dangerZone.getByText(/Delete all events/).textContent();
    const match = text?.match(/in\s+(.+?)\.\s/);
    const projectName = match?.[1]?.trim() ?? "E2E Project";

    await dangerZone.getByRole("button", { name: "Purge" }).click();
    const confirm = page.getByRole("button", { name: "Purge project data" });
    await expect(confirm).toBeDisabled();

    await page.locator("input.mono").fill("wrong name");
    await expect(confirm).toBeDisabled();

    await page.locator("input.mono").fill(projectName);
    await expect(confirm).toBeEnabled();
  });
});

test.describe("Settings area — viewer permissions @viewer", () => {
  test("viewer role hides key management actions", async ({ page }) => {
    await page.goto(`${baseURL}/settings/keys`);
    await page.waitForURL("**/settings/keys");

    await expect(page.locator("text=API keys")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mint API key" })).not.toBeVisible();
  });

  test("viewer role hides LLM provider management", async ({ page }) => {
    await page.goto(`${baseURL}/settings/llm`);
    await page.waitForURL("**/settings/llm");

    await expect(page.locator("text=LLM")).toBeVisible();
    await expect(page.locator("text=Higher role required")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save configuration" })).not.toBeVisible();
  });

  test("viewer role hides project purge", async ({ page }) => {
    await page.goto(`${baseURL}/settings/project`);
    await page.waitForURL("**/settings/project");

    await expect(page.locator("text=Project")).toBeVisible();
    await expect(page.getByRole("button", { name: "Purge" })).not.toBeVisible();
  });
});
