import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadManagedServers } from "../server/managed-servers.js";
import { Store } from "../server/store.js";

test("managed connections load secrets, stay read-only and coexist with persisted connections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stiva-managed-"));
  const store = await Store.open(dir);
  try {
    await writeFile(path.join(dir, "access"), "access\n");
    await writeFile(path.join(dir, "secret"), "secret\n");
    const file = path.join(dir, "servers.json");
    const config = {
      servers: [
        {
          id: "primary",
          name: "Primary",
          endpoint_url: "http://localhost:9000",
          access_key_file: "access",
          secret_key_file: "secret",
        },
      ],
    };
    await writeFile(file, JSON.stringify(config));
    const inputs = await loadManagedServers(file);
    store.setManaged(inputs);
    const local = await store.save({ ...inputs[0], name: "Local" });
    const app = createApp(store);
    const list = await request(app).get("/api/servers").expect(200);
    assert.equal(list.body.length, 2);
    assert.equal(list.body[0].managed, true);
    assert.equal(list.body[0].id, "managed:primary");
    assert.ok(!JSON.stringify(list.body).includes('"secret"'));
    const row = await store.row("managed:primary");
    assert.ok(row);
    assert.equal(store.credentials(row).secretAccessKey, "secret");
    await request(app).put("/api/servers/managed:primary").send(inputs[0]).expect(403);
    await request(app).delete("/api/servers/managed:primary").expect(403);
    assert.equal(
      await store
        .db("s3_servers")
        .count("* as n")
        .first()
        .then((r) => Number(r?.n)),
      1,
    );
    await writeFile(path.join(dir, "secret"), "rotated");
    store.setManaged(await loadManagedServers(file));
    const rotated = await store.row("managed:primary");
    assert.ok(rotated);
    assert.equal(store.credentials(rotated).secretAccessKey, "rotated");
    await writeFile(path.join(dir, "secret"), "");
    await assert.rejects(loadManagedServers(file), /Cannot load managed/);
    store.setManaged([]);
    assert.equal(await store.row("managed:primary"), undefined);
    assert.ok(await store.row(local.id));
    await writeFile(file, JSON.stringify({ servers: [config.servers[0], config.servers[0]] }));
    await assert.rejects(loadManagedServers(file), /Cannot load managed/);
    await writeFile(file, '{"secret":"do-not-leak"}');
    await assert.rejects(
      loadManagedServers(file),
      (error: Error) => !error.message.includes("do-not-leak"),
    );
    assert.deepEqual(await loadManagedServers(), []);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
