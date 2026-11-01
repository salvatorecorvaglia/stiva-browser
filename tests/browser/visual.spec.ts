import { expect, test } from "@playwright/test";
import { mockStorage, reset } from "./fixtures";

// Screenshots depend on OS font rendering. Keep this suite opt-in and use the
// included Chromium baselines on their matching platform.
test.skip(
  process.env.STIVA_VISUAL_TESTS !== "1",
  "Set STIVA_VISUAL_TESTS=1 for screenshot comparisons",
);
test.skip(({ browserName }) => browserName !== "chromium", "Baselines target Chromium");
test.use({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC" });

for (const theme of ["light", "dark"] as const) {
  test(`${theme} storage workspace`, async ({ page }) => {
    await reset(page);
    await mockStorage(page);
    await page.request.post("/api/servers", {
      data: {
        name: "Visual fixture",
        endpoint_url: "http://127.0.0.1:9000",
        region: "us-east-1",
        access_key: "fixture",
        secret_key: "fixture-secret",
        force_path_style: true,
      },
    });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Buckets" })
      .getByRole("button", { name: "project-assets" })
      .click();
    await expect(page.getByRole("button", { name: "hello.txt", exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot(`${theme}-workspace.png`, {
      animations: "disabled",
      fullPage: true,
      maxDiffPixelRatio: 0.001,
    });
  });
}
