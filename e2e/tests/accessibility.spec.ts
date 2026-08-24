import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { baseURL, stubShellApis } from "../utils/mockShell";

test.describe("Accessibility smoke", () => {
  test.beforeEach(async ({ page }) => {
    await stubShellApis(page);
  });

  for (const route of [
    { path: "/", heading: "Library" },
    { path: "/dashboard", heading: "Dashboard" },
    { path: "/settings", heading: "Settings" },
  ]) {
    test(route.heading + " has landmarks, a page heading, and no axe violations", async ({ page }) => {
      await page.goto(baseURL + route.path, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: route.heading, includeHidden: true })).toBeAttached();

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        // Fluent's Tabster focus sentinels are intentionally aria-hidden and
        // focusable. Exclude only those generated nodes, not the rule itself.
        .exclude("[data-tabster-dummy]")
        .analyze();

      expect(results.violations).toEqual([]);
    });
  }

  test("skip link moves focus to main content", async ({ page }) => {
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    const skipLink = page.getByRole("link", { name: "Skip to main content" });

    // Fluent Tabster may insert an initial focus sentinel. The skip link must
    // still be the first user-facing stop in the page.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await skipLink.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(skipLink).toBeFocused();
    await skipLink.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("client-side navigation announces and focuses the new page", async ({ page }) => {
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });

    await page.getByRole("link", { name: "Dashboard" }).click();

    const heading = page.getByRole("heading", { level: 1, name: "Dashboard" });
    await expect(page).toHaveTitle("Dashboard | Discogenius");
    await expect(heading).toBeFocused();
    await expect(page.locator('[role="status"][aria-atomic="true"]')).toHaveText("Dashboard page");
  });
});
