import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";

const execute = promisify(execFile);
test(
  "PostgreSQL migration preserves encrypted credentials, CRUD, and restart persistence",
  { skip: !process.env.STIVA_TEST_DB_URI, timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-postgres-"));
    let sqlite: Store | undefined = await Store.open(directory);
    let pg: Store | undefined;
    const ids: string[] = [];
    t.after(async () => {
      if (pg) {
        if (ids.length) await pg.db("s3_servers").whereIn("id", ids).delete();
        await pg.close();
      }
      await sqlite?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const config = {
      name: "Migrated fixture",
      endpoint_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      access_key: "postgres-access-fixture",
      secret_key: "postgres-secret-fixture",
      force_path_style: true,
    };
    const saved = await sqlite.save(config);
    ids.push(saved.id);
    const encrypted = (await sqlite.row(saved.id))!;
    await sqlite.close();
    sqlite = undefined;
    const environment = {
      ...process.env,
      DATA_DIR: directory,
      DB_URI: process.env.STIVA_TEST_DB_URI!,
    };
    const migrated = await execute(
      process.execPath,
      ["--import", "tsx", "server/migrate.ts"],
      { env: environment },
    );
    assert.ok(
      migrated.stdout.includes("Copied 1 encrypted server configurations"),
    );
    pg = await Store.open(directory, process.env.STIVA_TEST_DB_URI);
    const row = (await pg.row(saved.id))!;
    assert.equal(row.secret_key, encrypted.secret_key);
    assert.equal(row.access_key, encrypted.access_key);
    assert.equal(row.force_path_style, true);
    assert.equal(pg.credentials(row).secretAccessKey, config.secret_key);
    const app = createApp(pg);
    const created = (
      await request(app)
        .post("/api/servers")
        .send({ ...config, name: "Postgres created" })
        .expect(201)
    ).body;
    ids.push(created.id);
    assert.equal(created.secret_key, undefined);
    const { access_key: _a, secret_key: _s, ...update } = config;
    await request(app)
      .put(`/api/servers/${saved.id}`)
      .send({
        ...update,
        name: "Renamed on PostgreSQL",
        force_path_style: false,
      })
      .expect(200);
    assert.equal((await pg.row(saved.id))!.force_path_style, false);
    assert.equal(
      pg.credentials((await pg.row(saved.id))!).accessKeyId,
      config.access_key,
    );
    await pg.close();
    pg = await Store.open(directory, process.env.STIVA_TEST_DB_URI);
    assert.equal((await pg.row(saved.id))!.name, "Renamed on PostgreSQL");
    await assert.rejects(
      execute(process.execPath, ["--import", "tsx", "server/migrate.ts"], {
        env: environment,
      }),
    );
    assert.equal((await pg.list()).length, 2);
    await request(createApp(pg))
      .delete(`/api/servers/${created.id}`)
      .expect(204);
    assert.equal((await pg.list()).length, 1);
    sqlite = await Store.open(directory);
    assert.equal(
      (await sqlite.row(saved.id))!.secret_key,
      encrypted.secret_key,
    );
  },
);
