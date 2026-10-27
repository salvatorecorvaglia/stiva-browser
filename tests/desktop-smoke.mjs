import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "@playwright/test";

const requireDesktop = createRequire(new URL("../desktop/package.json", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "stiva-desktop-smoke-"));
let application;
try {
  application = await _electron.launch({
    executablePath: process.env.STIVA_DESKTOP_EXECUTABLE || requireDesktop("electron"),
    args: process.env.STIVA_DESKTOP_EXECUTABLE ? [] : [path.resolve("desktop")],
    env: { ...process.env, STIVA_DESKTOP_DATA_DIR: directory },
    timeout: 60000,
  });
  const page = await application.firstWindow();
  await page.getByRole("link", { name: "Stiva Browser home" }).waitFor();
  const origin = new URL(page.url()).origin;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await page.evaluate(async () => {
    const res = await fetch("/api/servers");
    return { status: res.status, servers: await res.json(), node: typeof window.require };
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.servers, []);
  assert.equal(response.node, "undefined");
  assert.equal((await fetch(`${origin}/api/servers`)).status, 403);
  await page.reload();
  await page.getByRole("link", { name: "Stiva Browser home" }).waitFor();
  console.log("Desktop smoke passed: renderer, SQLite, private API, reload and sandbox.");
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
