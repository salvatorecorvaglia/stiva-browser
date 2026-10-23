import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { type TestContext, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { type ClientFactory, createApp } from "../server/app.js";
import { deleteKeys } from "../server/deletion.js";
import { admission } from "../server/resources.js";
import { Store } from "../server/store.js";
import { uploadObject, uploadPartSize } from "../server/upload.js";
import { ApiError, api, deleteObjects, deletionBatches } from "../web/src/api.js";
import { mockSend, required, type S3Handler } from "./helpers.js";

const config = {
  name: "Reliability fixture",
  endpoint_url: "http://example.invalid",
  region: "us-east-1",
  access_key: "fixture",
  secret_key: "fixture-secret",
  force_path_style: true,
};
function clientFor(run: S3Handler) {
  const client = new S3Client({
    endpoint: config.endpoint_url,
    region: config.region,
    credentials: { accessKeyId: config.access_key, secretAccessKey: config.secret_key },
  });
  mockSend(client, run);
  return client;
}
async function fixture(t: TestContext, factory?: ClientFactory) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-reliability-"));
  const store = await Store.open(directory);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const saved = await store.save(config);
  return { directory, store, saved, app: createApp(store, { clientFactory: factory }) };
}

test("raw upload routes preserve bytes across case, trailing slash, MIME types, and empty bodies", async (t) => {
  const written: Buffer[] = [];
  const { app, saved } = await fixture(t, () =>
    clientFor(({ name, input }) => {
      assert.equal(name, "PutObjectCommand");
      assert.ok(input.Body instanceof Uint8Array);
      written.push(Buffer.from(input.Body));
      assert.equal(input.ContentLength, written.at(-1)?.length);
      return { ETag: "fixture" };
    }),
  );
  for (const route of ["/api/stream/upload", "/api/stream/upload/", "/API/stream/upload"]) {
    for (const [mime, data] of [
      ["application/json", "{invalid JSON: raw bytes}"],
      ["text/plain", "unicode 日本語"],
      ["application/octet-stream", ""],
    ]) {
      await request(app)
        .put(route)
        .query({ serverId: saved.id, bucket: "fixture", key: "raw" })
        .set("Content-Type", mime)
        .send(data)
        .expect(201);
      assert.deepEqual(written.at(-1), Buffer.from(data));
    }
  }
});

test("multipart completion failure settles work and cleans up before destroying the client", async () => {
  const calls: string[] = [];
  let active = 0;
  let maximum = 0;
  const client = clientFor(async ({ name, input }) => {
    calls.push(name);
    if (name === "CreateMultipartUploadCommand") return { UploadId: "fixture" };
    if (name === "UploadPartCommand") {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { ETag: `part-${input.PartNumber}` };
    }
    if (name === "CompleteMultipartUploadCommand") throw new Error("complete failed");
    assert.equal(name, "AbortMultipartUploadCommand");
    assert.equal(active, 0);
    return {};
  });
  try {
    await assert.rejects(
      uploadObject(
        client,
        { bucket: "fixture", key: "large", contentType: "text/plain" },
        Readable.from([Buffer.alloc(25 * 1024 ** 2)]),
        new AbortController().signal,
      ),
      /complete failed/,
    );
    assert.equal(calls.at(-1), "AbortMultipartUploadCommand");
    assert.equal(maximum, 2);
  } finally {
    client.destroy();
  }
});

test("multipart part failure, cancellation, and cleanup failure are accounted for", async () => {
  for (const scenario of ["part", "cancel", "cleanup", "checksum"]) {
    const controller = new AbortController();
    let cleanup = false;
    let active = 0;
    const client = clientFor(async ({ name }, signal) => {
      if (name === "CreateMultipartUploadCommand") return { UploadId: "fixture" };
      if (name === "UploadPartCommand") {
        active++;
        try {
          if (scenario === "cancel") controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (signal?.aborted) throw new Error("aborted");
          if (scenario === "checksum") return {};
          throw new Error("part failed");
        } finally {
          active--;
        }
      }
      if (name === "AbortMultipartUploadCommand") {
        assert.equal(active, 0);
        assert.equal(signal?.aborted, false);
        cleanup = true;
        if (scenario === "cleanup") throw new Error("cleanup failed");
        return {};
      }
      throw new Error("completion must not execute");
    });
    try {
      await assert.rejects(
        uploadObject(
          client,
          { bucket: "fixture", key: "large", contentType: "application/octet-stream" },
          Readable.from([Buffer.alloc(17 * 1024 ** 2)]),
          controller.signal,
        ),
        scenario === "cleanup" ? /cleanup could not be confirmed/ : /part failed|aborted|checksum/,
      );
      assert.equal(cleanup, true);
    } finally {
      client.destroy();
    }
  }
});

test("multipart success preserves part ordering and content; lengths and part sizes are bounded", async () => {
  const data = Buffer.alloc(17 * 1024 ** 2, "s");
  const parts: Buffer[] = [];
  const client = clientFor(({ name, input }) => {
    if (name === "CreateMultipartUploadCommand") return { UploadId: "fixture" };
    if (name === "UploadPartCommand") {
      assert.ok(input.Body instanceof Uint8Array);
      parts[required(input.PartNumber) - 1] = Buffer.from(input.Body);
      return { ETag: `part-${input.PartNumber}` };
    }
    assert.equal(name, "CompleteMultipartUploadCommand");
    assert.deepEqual(
      required(input.MultipartUpload?.Parts).map((part) => part.PartNumber),
      [1, 2, 3],
    );
    return {};
  });
  try {
    await uploadObject(
      client,
      {
        bucket: "fixture",
        key: "large",
        contentType: "application/octet-stream",
        length: data.length,
      },
      Readable.from([data]),
      new AbortController().signal,
    );
    assert.deepEqual(Buffer.concat(parts), data);
    await assert.rejects(
      uploadObject(
        client,
        { bucket: "fixture", key: "short", contentType: "text/plain", length: 10 },
        Readable.from(["short"]),
        new AbortController().signal,
      ),
      /length does not match/,
    );
    assert.equal(uploadPartSize(), 8 * 1024 ** 2);
    assert.equal(uploadPartSize(10000 * 16 * 1024 ** 2), 16 * 1024 ** 2);
    assert.throws(() => uploadPartSize(10000 * 16 * 1024 ** 2 + 1), /limit/);
    assert.throws(() => uploadPartSize(-1), /Invalid/);
  } finally {
    client.destroy();
  }
});

test("ordinary deletion retains earlier results, deduplicates, and flags missing acknowledgments", async () => {
  let batch = 0;
  const client = clientFor(({ name, input }) => {
    assert.equal(name, "DeleteObjectsCommand");
    if (++batch === 2) throw new Error("lost response");
    return { Deleted: required(input.Delete?.Objects).slice(1), Errors: [] };
  });
  try {
    const keys = Array.from({ length: 1001 }, (_, i) => `key-${i}`);
    const result = await deleteKeys(client, "fixture", [...keys, keys[0]]);
    assert.equal(batch, 2);
    assert.equal(result.deleted.length, 999);
    assert.deepEqual(result.errors, [
      { key: "key-0", code: "UnconfirmedDeletion" },
      { key: "key-1000", code: "UnconfirmedDeletion" },
    ]);
  } finally {
    client.destroy();
  }
});

test("conditional updates reject stale edits; omitted credentials use the current row", async (t) => {
  const { app, store, saved } = await fixture(t);
  const stale = required(await store.row(saved.id));
  await request(app)
    .put(`/api/servers/${saved.id}`)
    .set("If-Match", `"${saved.revision}"`)
    .send({ ...config, secret_key: "rotated" })
    .expect(200);
  await request(app)
    .put(`/api/servers/${saved.id}`)
    .set("If-Match", `"${saved.revision}"`)
    .send(config)
    .expect(412);
  const { access_key: _a, secret_key: _s, ...other } = config;
  await store.save({ ...other, name: "retained latest" }, stale);
  assert.equal(store.credentials(required(await store.row(saved.id))).secretAccessKey, "rotated");
  await store.db("s3_servers").where({ id: saved.id }).delete();
  await assert.rejects(store.save(config, stale), /not found/);
});

test("simultaneous SQLite conditional edits have exactly one winner", async (t) => {
  const { app, store, saved } = await fixture(t);
  const responses = await Promise.all(
    ["first", "second"].map((name) =>
      request(app)
        .put(`/api/servers/${saved.id}`)
        .set("If-Match", `"${saved.revision}"`)
        .send({ ...config, name }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 412]);
  const winner = required(responses.find((response) => response.status === 200));
  assert.equal(required(await store.row(saved.id)).name, winner.body.name);
});

test("API rate limits spare health probes and use explicitly trusted proxy addresses", async (t) => {
  const { store } = await fixture(t);
  const app = createApp(store, { apiLimit: 1, trustProxy: "loopback" });
  await request(app).get("/api/servers").set("X-Forwarded-For", "203.0.113.1").expect(200);
  const limited = await request(app)
    .get("/api/servers")
    .set("X-Forwarded-For", "203.0.113.1")
    .expect(429);
  assert.ok(limited.headers["retry-after"]);
  await request(app).get("/api/servers").set("X-Forwarded-For", "203.0.113.2").expect(200);
  await request(app).get("/api/stream/download").set("X-Forwarded-For", "203.0.113.1").expect(429);
  await request(app).get("/api/health/live").expect(200);
  await request(app).get("/api/health/ready").expect(200);
  await request(createApp(store))
    .post("/api/servers")
    .send({ ...config, endpoint_url: "not-a-url" })
    .expect(400);
  for (const origin of ["null", "not-a-url", "https://attacker.invalid"])
    await request(createApp(store))
      .post("/api/servers")
      .set("Origin", origin)
      .send(config)
      .expect(403);
});

test("admission rejects excess work without queueing and releases failed operations", async () => {
  const run = admission(1);
  let release = () => {};
  const first = run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    run(async () => {}),
    /capacity/,
  );
  release();
  await first;
  await assert.rejects(
    run(async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  await run(async () => {});
});

test("bucket listing explicitly paginates and rejects repeated tokens", async (t) => {
  let repeat = false;
  const { app, saved } = await fixture(t, () =>
    clientFor(({ name, input }) => {
      assert.equal(name, "ListBucketsCommand");
      assert.equal(input.MaxBuckets, 1000);
      return {
        Buckets: [{ Name: input.ContinuationToken ? "second" : "first" }],
        ContinuationToken: !input.ContinuationToken || repeat ? "next" : undefined,
      };
    }),
  );
  const output = await request(app).get("/api/buckets").set("x-s3-server-id", saved.id).expect(200);
  assert.equal(output.body.buckets.length, 2);
  repeat = true;
  await request(app).get("/api/buckets").set("x-s3-server-id", saved.id).expect(502);
});

test("deletion batches fit JSON limits and retain successes after transport errors", async (t) => {
  const keys = Array.from({ length: 200 }, (_, i) => `${i}-${"日".repeat(300)}\n`);
  const batches = deletionBatches([...keys, keys[0]]);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), keys);
  for (const batch of batches)
    assert.ok(Buffer.byteLength(JSON.stringify({ keys: batch })) < 64 * 1024);
  let call = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    if (++call === 2) throw new Error("transport failure");
    return Response.json({ deleted: JSON.parse(String(options.body)).keys, errors: [] });
  });
  const result = await deleteObjects("fixture", "fixture", keys);
  assert.equal(result.deleted.length + result.errors.length, keys.length);
  assert.equal(result.errors.length, batches[1].length);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }),
  );
  await assert.rejects(
    api("/fixture"),
    (error) => error instanceof ApiError && error.status === 404 && error.code === "NOT_FOUND",
  );
});

test("tampered encrypted credentials and invalid master keys refuse startup", async () => {
  for (const scenario of ["ciphertext", "invalid-key", "wrong-key"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-corrupt-"));
    const store = await Store.open(directory);
    const saved = await store.save(config);
    if (scenario === "ciphertext") {
      const row = required(await store.row(saved.id));
      const parts = row.secret_key.split(":");
      const ciphertext = Buffer.from(parts[3], "base64");
      ciphertext[0] ^= 1;
      parts[3] = ciphertext.toString("base64");
      await store
        .db("s3_servers")
        .where({ id: saved.id })
        .update({ secret_key: parts.join(":") });
    }
    await store.close();
    if (scenario !== "ciphertext")
      await writeFile(
        path.join(directory, "master.key"),
        Buffer.alloc(scenario === "invalid-key" ? 3 : 32),
      );
    await assert.rejects(Store.open(directory));
    assert.ok((await readFile(path.join(directory, "master.key"))).length > 0);
    await rm(directory, { recursive: true, force: true });
  }
});
