import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockStorage, reset } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await reset(page);
  await mockStorage(page);
});

test("theme follows system changes and remembers explicit preferences", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = page.locator("html");
  const picker = page.getByLabel("Color theme");
  await expect(picker).toHaveValue("system");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await picker.selectOption("dark");
  await page.reload();
  await expect(picker).toHaveValue("dark");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await picker.selectOption("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await picker.selectOption("system");
  await expect(root).toHaveAttribute("data-theme", "dark");
});

test("dark workspace and server dialog remain accessible", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  for (const dialog of [false, true]) {
    if (dialog) await page.getByRole("button", { name: "Manage servers" }).click();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(result.violations).toEqual([]);
  }
  await page.screenshot({ path: "test-results/theme-dark.png", fullPage: true });
});
