import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createServer } from "vite";
import { originGuard } from "../server/resources.js";
import config from "../vite.config.js";

test("development proxy preserves same-origin API writes and rejects foreign origins", async (t) => {
  const app = express();
  app.use(originGuard);
  app.post("/api/probe", (_req, res) => res.sendStatus(204));
  const backend = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  await once(backend, "listening");
  const proxy = config.server?.proxy?.["/api"];
  assert.ok(proxy && typeof proxy === "object");
  const vite = await createServer({
    configFile: false,
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/api": { ...proxy, target: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` },
      },
    },
  });
  t.after(() => vite.close());
  await vite.listen();
  assert.ok(vite.httpServer);
  const origin = `http://127.0.0.1:${(vite.httpServer.address() as AddressInfo).port}`;
  for (const [requestOrigin, status] of [
    [origin, 204],
    ["https://foreign.invalid", 403],
  ] as const) {
    const response = await fetch(`${origin}/api/probe`, {
      method: "POST",
      headers: { Origin: requestOrigin },
    });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
});
