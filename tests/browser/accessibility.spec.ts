import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { mockStorage, reset } from "./fixtures";

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([]);
}
async function seeded(page: Page) {
  await page.request.post("/api/servers", {
    data: {
      name: "Accessibility fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
}
test.beforeEach(async ({ page }) => {
  await reset(page);
  await mockStorage(page);
});

test("welcome and server management pass accessibility scans and keep modal focus", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A home for all your storage." })).toBeVisible();
  await audit(page);
  const opener = page.getByRole("button", { name: "Connect your first server" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await audit(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

test("object listing, details, preview, creation and deletion dialogs pass scans", async ({
  page,
}) => {
  await seeded(page);
  await audit(page);
  await page.getByTitle("Object metadata", { exact: true }).first().click();
  await expect(page.getByText("text/plain", { exact: true })).toBeVisible();
  await audit(page);
  const details = page.getByRole("tab", { name: "Metadata" });
  await details.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toBeFocused();
  await expect(page.getByText("Hello Stiva!", { exact: true })).toBeVisible();
  await audit(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New folder" }).click();
  await audit(page);
  await page.keyboard.press("Escape");
  await page.getByTitle("Delete hello.txt", { exact: true }).click();
  await audit(page);
  await page.keyboard.press("Escape");
});

test("mobile navigation, zoomed content and reduced motion remain accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await audit(page);
  await page.getByRole("button", { name: "Toggle buckets" }).click();
  await audit(page);
  await page.getByRole("button", { name: "Close bucket navigation" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Manage servers" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 320, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("storage errors and version confirmations pass scans", async ({ page }) => {
  await seeded(page);
  await page.route("**/api/buckets/project-assets/versions?*", (route) =>
    route.fulfill({
      json: {
        versions: [
          {
            key: "hello.txt",
            version_id: "v1",
            size: 12,
            is_latest: true,
            is_delete_marker: false,
          },
        ],
        next_key_marker: null,
        next_version_id_marker: null,
      },
    }),
  );
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
  await audit(page);
  await page.getByTitle("Permanently delete version v1").click();
  await audit(page);
  await page.keyboard.press("Escape");
  await page.route("**/api/buckets/project-assets/objects?*", (route) =>
    route.fulfill({
      status: 502,
      json: { error: { code: "STORAGE_ERROR", message: "Storage unavailable" } },
    }),
  );
  await page.getByTitle("Refresh objects").click();
  await expect(page.getByText("Storage unavailable", { exact: true })).toBeVisible();
  await audit(page);
});
