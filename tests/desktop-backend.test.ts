import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startDesktop } from "../server/desktop.js";

test("desktop listener requires its token for reads, writes and static content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stiva-desktop-"));
  const token = randomBytes(32).toString("hex");
  const backend = await startDesktop(directory, path.resolve("dist/web"), token);
  try {
    assert.match(backend.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    for (const resource of ["/", "/api/servers", "/api/health/live"]) {
      assert.equal((await fetch(backend.origin + resource)).status, 403);
      assert.equal(
        (await fetch(backend.origin + resource, { headers: { "x-stiva-desktop-token": "wrong" } }))
          .status,
        403,
      );
    }
    const headers = { "x-stiva-desktop-token": token };
    const response = await fetch(`${backend.origin}/api/servers`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    assert.equal(
      (
        await fetch(`${backend.origin}/api/servers`, {
          method: "POST",
          headers: { ...headers, origin: "https://untrusted.example" },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await Promise.all([backend.close(), backend.close()]);
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(fetch(`${backend.origin}/api/health/live`));
});
