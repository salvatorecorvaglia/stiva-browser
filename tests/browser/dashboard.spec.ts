import { expect, test } from "@playwright/test";

import { mockStorage, reset } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await reset(page);
  await mockStorage(page);
});

test("empty workspace, server CRUD, bucket and folder navigation, search and safe preview", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A home for all your storage." })).toBeVisible();
  await page.getByRole("button", { name: "Connect your first server" }).click();
  await expect(page.getByRole("dialog", { name: "Manage servers" })).toBeVisible();
  await page.getByLabel("Server name").fill("Development");
  await page.getByLabel("Endpoint URL").fill("http://127.0.0.1:9000");
  await page.getByLabel("Access key", { exact: true }).fill("browser-access");
  await page.getByLabel("Secret key", { exact: true }).fill("browser-secret");
  await page.route("**/api/servers/test", (route) =>
    route.fulfill({ json: { connected: true, bucket_count: 2 } }),
  );
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status")).toContainText("Connected successfully");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Manage servers" })).not.toBeVisible();
  await expect(page.getByLabel("Select S3 server").locator("option:checked")).toHaveText(
    "Development",
  );
  await page.getByRole("button", { name: "Manage servers" }).click();
  await expect(page.getByRole("button", { name: "Development us-east-1" })).toBeVisible();
  await page.getByRole("button", { name: "Development us-east-1" }).click();
  await expect(page.getByLabel("Access key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Secret key", { exact: true })).toHaveValue("");
  await page.getByLabel("Server name").fill("Development updated");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog", { name: "Manage servers" })).not.toBeVisible();
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await expect(page.getByRole("heading", { name: "project-assets." })).toBeVisible();
  await expect(page.getByRole("button", { name: "hello.txt", exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/stiva-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Search this page").fill("photo");
  await expect(page.getByRole("button", { name: "hello.txt", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "documents", exact: true }).click();
  await expect(page.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Parent folder" }).click();
  await page.getByRole("button", { name: "hello.txt", exact: true }).click();
  await expect(page.getByText("Hello Stiva!", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Metadata", exact: true }).click();
  await expect(page.getByText("text/plain", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Copy presigned URL" }).click();
  await expect(page.getByRole("dialog", { name: "Presigned download URL" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Download URL", exact: true })).toHaveValue(
    "http://127.0.0.1:4173/example-signed-download",
  );
  await expect(page.getByRole("link", { name: "Open download" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:4173/example-signed-download",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Manage servers" }).click();
  await page.getByRole("button", { name: "Remove Development updated", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("heading", { name: "A home for all your storage." })).toBeVisible();
});

test("new folder, deletion, and backend upload progress", async ({ page }) => {
  await page.request.post("/api/servers", {
    data: {
      name: "Fixture",
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
  let folderKey = "";
  await page.route("**/api/buckets/project-assets/folders", (route) => {
    folderKey = route.request().postDataJSON().key;
    return route.fulfill({ status: 201, json: { key: folderKey } });
  });
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("new-folder");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(folderKey).toBe("new-folder/");
  await page.route("**/api/buckets/project-assets/objects", (route) =>
    route.fulfill({
      json: { deleted: route.request().postDataJSON().keys, errors: [] },
    }),
  );
  await page.getByLabel("Select hello.txt", { exact: true }).check();
  await page.getByRole("button", { name: "Delete (1)", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("hello.txt");
  await page.getByRole("button", { name: "Delete objects", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.route("**/api/buckets/project-assets/objects/metadata?*", (route) =>
    route.fulfill({
      status: 404,
      json: { error: { message: "S3 bucket or object not found." } },
    }),
  );
  await page.getByLabel("Transfer through backend").check();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded content"),
  });
  await expect(page.getByText("Upload complete", { exact: true })).toBeVisible();
  expect(await (await page.request.get("/__test/upload")).text()).toBe("uploaded content");
});

test("server switching clears bucket context and uses the correct header", async ({ page }) => {
  const one = await page.request.post("/api/servers", {
    data: {
      name: "One",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "one",
      secret_key: "one-secret",
      force_path_style: true,
    },
  });
  const two = await page.request.post("/api/servers", {
    data: {
      name: "Two",
      endpoint_url: "http://127.0.0.1:9001",
      region: "us-east-1",
      access_key: "two",
      secret_key: "two-secret",
      force_path_style: true,
    },
  });
  const first = await one.json();
  const second = await two.json();
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  const next = page.waitForRequest(
    (req) => req.url().endsWith("/api/buckets") && req.headers()["x-s3-server-id"] === second.id,
  );
  await page.getByLabel("Select S3 server").selectOption(second.id);
  await next;
  await expect(page.getByRole("heading", { name: "Your storage workspace." })).toBeVisible();
  expect(first.id).not.toBe(second.id);
});

test("mobile navigation and accessible dialog keyboard dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post("/api/servers", {
    data: {
      name: "Mobile",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "mobile",
      secret_key: "mobile-secret",
      force_path_style: true,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle buckets" }).click();
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await expect(page.getByRole("heading", { name: "project-assets." })).toBeVisible();
  expect(
    await page
      .locator(".stat small")
      .evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: "test-results/stiva-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Manage servers" }).click();
  await expect(page.getByRole("dialog", { name: "Manage servers" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("failed direct upload offers an explicit backend retry", async ({ page }) => {
  await page.request.post("/api/servers", {
    data: {
      name: "Fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  await page.route("**/api/buckets/project-assets/objects/metadata?*", (route) =>
    route.fulfill({
      status: 404,
      json: { error: { message: "S3 bucket or object not found." } },
    }),
  );
  await page.route("**/api/presigned-url/upload", (route) =>
    route.fulfill({
      json: {
        url: "http://127.0.0.1:4173/failed-direct-upload",
        required_headers: { "Content-Type": "text/plain" },
        expires_at: "2026-10-23T12:00:00Z",
      },
    }),
  );
  await page.route("**/failed-direct-upload", (route) => route.abort("failed"));
  let proxyRequests = 0;
  await page.route("**/api/stream/upload?*", (route) => {
    proxyRequests++;
    return route.fulfill({ status: 201, json: { key: "retry.txt" } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry payload"),
  });
  await expect(page.getByRole("button", { name: "Retry through backend" })).toBeVisible();
  expect(proxyRequests).toBe(0);
  await page.getByRole("button", { name: "Retry through backend" }).click();
  await expect(page.getByText("Upload complete", { exact: true })).toBeVisible();
  expect(proxyRequests).toBe(1);
});

test("recursive folder deletion requires a reviewed preview and exact confirmation", async ({
  page,
}) => {
  await page.request.post("/api/servers", {
    data: {
      name: "Folder fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  await page.route("**/api/buckets/project-assets/folders/delete-preview?*", (route) =>
    route.fulfill({
      json: {
        preview_token: "8b962ad9-ed10-4ba9-a19f-9d30b0d4ef11",
        prefix: "documents/",
        count: 2,
        size: 1024,
        sample: ["documents/a.txt", "documents/nested/b.txt"],
        expires_at: new Date(Date.now() + 300000).toISOString(),
      },
    }),
  );
  let deletion: { prefix: string; confirmation: string; preview_token: string } | undefined;
  await page.route("**/api/buckets/project-assets/folders", (route) => {
    deletion = route.request().postDataJSON();
    return route.fulfill({
      json: {
        deleted: ["documents/a.txt", "documents/nested/b.txt"],
        errors: [],
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await page
    .getByRole("button", {
      name: "Delete folder and contents documents/",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete folder and contents?",
  });
  await expect(dialog.getByText("2 objects", { exact: true })).toBeVisible();
  await expect(dialog.getByText("documents/nested/b.txt", { exact: true })).toBeVisible();
  const remove = dialog.getByRole("button", {
    name: "Delete folder contents",
    exact: true,
  });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel("Type the complete folder prefix to confirm").fill("documents");
  await expect(remove).toBeDisabled();
  await dialog.getByLabel("Type the complete folder prefix to confirm").fill("documents/");
  await remove.click();
  await expect(dialog).not.toBeVisible();
  expect(deletion).toEqual({
    prefix: "documents/",
    confirmation: "documents/",
    preview_token: "8b962ad9-ed10-4ba9-a19f-9d30b0d4ef11",
  });
});

test("version history restores data and permanently removes a marker with typed confirmation", async ({
  page,
}) => {
  await page.request.post("/api/servers", {
    data: {
      name: "Version fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  let versions = [
    {
      key: "hello.txt",
      version_id: "v1",
      is_latest: false,
      is_delete_marker: false,
      size: 12,
      last_modified: "2026-10-20T10:00:00Z",
    },
    {
      key: "hello.txt",
      version_id: "marker",
      is_latest: true,
      is_delete_marker: true,
      size: 0,
      last_modified: "2026-10-21T10:00:00Z",
    },
  ];
  await page.route("**/api/buckets/project-assets/versions?*", (route) =>
    route.fulfill({
      json: { versions, next_key_marker: null, next_version_id_marker: null },
    }),
  );
  let restored = false;
  await page.route("**/api/buckets/project-assets/versions/restore", (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({
      key: "hello.txt",
      versionId: "v1",
      confirmation: "hello.txt",
    });
    restored = true;
    versions = versions.map((version) => ({ ...version, is_latest: false }));
    versions.push({
      key: "hello.txt",
      version_id: "restored",
      is_latest: true,
      is_delete_marker: false,
      size: 12,
      last_modified: "2026-10-23T10:00:00Z",
    });
    return route.fulfill({
      status: 201,
      json: { key: "hello.txt", version_id: "restored" },
    });
  });
  await page.route("**/api/buckets/project-assets/versions", (route) => {
    const body = route.request().postDataJSON();
    expect(body.versionId).toBe("marker");
    expect(body.confirmation).toBe("hello.txt");
    versions = versions.filter((version) => version.version_id !== "marker");
    return route.fulfill({
      json: { deleted: true, key: "hello.txt", version_id: "marker" },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Object versions" });
  await expect(dialog.getByText("Delete marker", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Download version v1", exact: true }),
  ).toHaveAttribute("href", /versionId=v1/);
  await dialog.getByRole("button", { name: "Restore version v1", exact: true }).click();
  const restore = dialog.getByRole("button", {
    name: "Restore version",
    exact: true,
  });
  await expect(restore).toBeDisabled();
  await dialog.getByLabel("Type the complete object key to confirm").fill("hello.txt");
  await restore.click();
  await expect(
    dialog.getByText("Restored as a new current version. Previous versions were retained.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(restored).toBe(true);
  await dialog
    .getByRole("button", {
      name: "Permanently delete version marker",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByText("Removing a delete marker may make an earlier version visible again.", {
      exact: false,
    }),
  ).toBeVisible();
  await dialog.getByLabel("Type the complete object key to confirm").fill("hello.txt");
  await dialog.getByRole("button", { name: "Permanently delete version", exact: true }).click();
  await expect(dialog.getByText("Version permanently deleted.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Delete marker", { exact: true })).not.toBeVisible();
});

test("bucket refresh preserves an active upload and its location", async ({ page }) => {
  await page.request.post("/api/servers", {
    data: {
      name: "Refresh fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  await page.route("**/api/buckets/project-assets/objects/metadata?*", (route) =>
    route.fulfill({ status: 404, json: { error: { message: "missing" } } }),
  );
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/stream/upload?*", async (route) => {
    await pending;
    await route.fulfill({ status: 201, json: { key: "documents/refresh.txt" } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await page.getByRole("button", { name: "documents", exact: true }).click();
  await page.getByLabel("Transfer through backend").check();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "refresh.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("refresh fixture"),
  });
  await expect(page.getByTitle("Cancel upload", { exact: true })).toBeVisible();
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/buckets"));
  await page.getByTitle("Reload buckets", { exact: true }).click();
  await refreshed;
  await expect(page.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
  await expect(page.getByTitle("Cancel upload", { exact: true })).toBeVisible();
  await expect(page.getByText("canceled", { exact: true })).not.toBeVisible();
  release();
  await expect(page.getByText("Upload complete", { exact: true })).toBeVisible();
});

test("closed mobile navigation leaves the tab order and restores toggle focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post("/api/servers", {
    data: {
      name: "Keyboard fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Toggle buckets" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest("#bucket-sidebar"))),
    ).toBe(false);
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("metadata loads without fetching a preview and meaningful text has sufficient contrast", async ({
  page,
}) => {
  await page.request.post("/api/servers", {
    data: {
      name: "Metadata fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "fixture",
      secret_key: "fixture-secret",
      force_path_style: true,
    },
  });
  let previews = 0;
  await page.route("**/api/stream/download?*", (route) => {
    previews++;
    return route.fulfill({ contentType: "text/plain", body: "preview contents" });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Buckets" })
    .getByRole("button", { name: "project-assets" })
    .click();
  const ratio = await page
    .locator(".date-cell")
    .first()
    .evaluate((element) => {
      const color =
        getComputedStyle(element)
          .color.match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number) ?? [];
      const luminance = color
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      return 1.05 / (luminance + 0.05);
    });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  const buttonContrast = await page
    .locator(".button.primary")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color: string) =>
        (
          color
            .match(/[\d.]+/g)
            ?.slice(0, 3)
            .map(Number) ?? []
        )
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  expect(buttonContrast).toBeGreaterThanOrEqual(4.5);

  await page.getByTitle("Object metadata", { exact: true }).first().click();
  await expect(page.getByText("text/plain", { exact: true })).toBeVisible();
  expect(previews).toBe(0);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.getByText("preview contents", { exact: true })).toBeVisible();
  expect(previews).toBe(1);
});

test("copied S3 URIs omit the server name and stale signed links do not reopen dialogs", async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.request.post("/api/servers", {
    data: {
      name: "URI fixture",
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
  await page.getByTitle("Copy S3 path", { exact: true }).click();
  if (browserName === "chromium")
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("s3://project-assets/");
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/presigned-url/download", async (route) => {
    await pending;
    await route.fulfill({
      json: {
        url: "http://127.0.0.1:4173/old-link",
        expires_at: new Date().toISOString(),
        required_headers: {},
      },
    });
  });
  const requested = page.waitForRequest("**/api/presigned-url/download");
  await page.getByTitle("Copy presigned URL", { exact: true }).first().click();
  await requested;
  await page.getByRole("button", { name: "documents", exact: true }).click();
  const responded = page.waitForResponse("**/api/presigned-url/download");
  release();
  await responded;
  await expect(page.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("sidebar groups buckets by server and opens a bucket on another server", async ({ page }) => {
  const ids: string[] = [];
  for (const name of ["Development", "Production"]) {
    const response = await page.request.post("/api/servers", {
      data: {
        name,
        endpoint_url: "http://127.0.0.1:9000",
        region: "us-east-1",
        access_key: "fixture",
        secret_key: "fixture-secret",
        force_path_style: true,
      },
    });
    ids.push((await response.json()).id);
  }
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Buckets" });
  for (const name of ["Development", "Production"]) {
    await expect(
      navigation
        .getByRole("region", { name, exact: true })
        .getByRole("button", { name: "project-assets", exact: true }),
    ).toBeVisible();
  }
  const selectedId = await page.getByLabel("Select S3 server").inputValue();
  const targetIndex = selectedId === ids[0] ? 1 : 0;
  const targetName = ["Development", "Production"][targetIndex];
  await navigation
    .getByRole("region", { name: targetName, exact: true })
    .getByRole("button", { name: "project-assets", exact: true })
    .click();
  await expect(page.getByLabel("Select S3 server")).toHaveValue(ids[targetIndex]);
  await expect(page.getByRole("heading", { name: "project-assets." })).toBeVisible();
  await expect(page.getByRole("button", { name: "hello.txt", exact: true })).toBeVisible();
});
