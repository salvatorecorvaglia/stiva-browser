import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("production entrypoint starts on an ephemeral port and shuts down cleanly", {
  timeout: 15000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-startup-"));
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, DATA_DIR: directory, DB_URI: "", PORT: "0", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on http:\/\/localhost:(\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Entrypoint exited before startup")));
  });
  assert.ok(port > 0);
  const result = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
  assert.equal(result.status, 200);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
});

test("entrypoint exits on invalid ports and occupied listeners without exposing secrets", {
  timeout: 15000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-startup-failure-"));
  const listener = createServer().listen(0, "0.0.0.0");
  await once(listener, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  for (const port of ["invalid", "65536", String(address.port)]) {
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: { ...process.env, DATA_DIR: directory, DB_URI: "", PORT: port, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    assert.equal((await once(child, "exit"))[0], 1);
    assert.match(stderr, /could not initialize/);
    assert.doesNotMatch(stderr, /master.key|EADDRINUSE|stack/);
  }
});
