import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { type TestContext, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { type ClientFactory, createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { mockSend, required } from "./helpers.js";

const config = {
  name: "Primary storage",
  endpoint_url: "http://127.0.0.1:9000",
  region: "us-east-1",
  access_key: "unit-access-key",
  secret_key: "unit-secret-key",
  force_path_style: true,
};
const factory: ClientFactory = (input, credentials) => {
  const client = new S3Client({
    endpoint: input.endpoint_url,
    region: input.region,
    forcePathStyle: true,
    credentials,
  });
  mockSend(client, (command) => {
    if (credentials.secretAccessKey === "wrong")
      throw Object.assign(new Error("credential material must not leak"), {
        $metadata: { httpStatusCode: 403 },
      });
    switch (command.name) {
      case "ListBucketsCommand":
        return {
          Buckets: [
            {
              Name: input.endpoint_url.includes("9001") ? "secondary" : "documents",
            },
          ],
        };
      case "ListObjectsV2Command":
        return {
          Contents: [{ Key: `${command.input.Prefix}hello.txt`, Size: 5 }],
          CommonPrefixes: [{ Prefix: "folder/" }],
          NextContinuationToken: command.input.ContinuationToken ? undefined : "page-two",
        };
      case "HeadObjectCommand":
        return {
          ContentLength: 5,
          ContentType: "text/plain",
          Metadata: { source: "fixture" },
        };
      case "GetObjectCommand":
        return {
          Body: Readable.from(["hello"]),
          ContentLength: 5,
          ContentType: command.input.Key === "unsafe.svg" ? "image/svg+xml" : "text/plain",
        };
      case "DeleteObjectCommand":
        return {};
      case "DeleteObjectsCommand":
        return {
          Deleted: required(command.input.Delete?.Objects)
            .filter((item) => item.Key !== "denied")
            .map((item) => ({ Key: item.Key })),
          Errors: required(command.input.Delete?.Objects).some((item) => item.Key === "denied")
            ? [{ Key: "denied", Code: "AccessDenied" }]
            : [],
        };
      case "PutObjectCommand":
        return { ETag: "test" };
      default:
        throw new Error(`Unexpected ${command.name}`);
    }
  });
  return client;
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-unit-"));
  const store = await Store.open(directory);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const app = createApp(store, { clientFactory: factory });
  return { directory, store, app };
}

test("static assets and SPA fallback share a rate limit before filesystem access", async (t) => {
  const { directory, store } = await fixture(t);
  await writeFile(path.join(directory, "index.html"), "<html>Stiva</html>");
  await writeFile(path.join(directory, "asset.txt"), "asset");
  const app = createApp(store, { staticDirectory: directory });

  for (let i = 0; i < 300; i++) {
    const response = await request(app)
      .get(i % 2 === 0 ? "/asset.txt" : "/dashboard")
      .expect(200);
    assert.equal(response.text, i % 2 === 0 ? "asset" : "<html>Stiva</html>");
  }
  for (const route of ["/asset.txt", "/dashboard"]) {
    const response = await request(app)
      .get(route)
      .set("X-Forwarded-For", "203.0.113.1")
      .expect(429);
    assert.equal(response.body.error.code, "RATE_LIMITED");
    assert.ok(Number(response.headers["retry-after"]) > 0);
  }
  await request(app).get("/api/health/live").expect(200);
  await request(app).get("/api/missing").expect(404);
  await request(createApp(store, { staticDirectory: directory }))
    .get("/dashboard")
    .expect(200);
});

test("credentials are encrypted, redacted, retained on update, and survive restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-restart-"));
  let store = await Store.open(directory);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  let app = createApp(store, { clientFactory: factory });
  const created = await request(app).post("/api/servers").send(config).expect(201);
  const id = created.body.id;
  assert.equal(created.body.secret_key, undefined);
  assert.equal(created.body.access_key, "••••••••");
  const row = await store.row(id);
  assert.ok(row?.secret_key.startsWith("v1:"));
  assert.ok(!JSON.stringify(row).includes(config.secret_key));
  assert.ok(!JSON.stringify(row).includes(config.access_key));
  assert.equal((await stat(path.join(directory, "master.key"))).mode & 0o777, 0o600);
  assert.equal(store.credentials(required(row)).secretAccessKey, config.secret_key);
  const { secret_key: _secret, access_key: _access, ...other } = config;
  await request(app)
    .put(`/api/servers/${id}`)
    .send({ ...other, name: "Renamed" })
    .expect(200);
  assert.equal(store.credentials(required(await store.row(id))).accessKeyId, config.access_key);
  await store.close();
  store = await Store.open(directory);
  app = createApp(store, { clientFactory: factory });
  const listed = await request(app).get("/api/servers").expect(200);
  assert.equal(listed.body[0].name, "Renamed");
  await request(app).get("/api/buckets").set("x-s3-server-id", id).expect(200);
  await request(app)
    .put(`/api/servers/${id}`)
    .send({ ...other, secret_key: "replacement" })
    .expect(200);
  assert.equal(store.credentials(required(await store.row(id))).secretAccessKey, "replacement");
  await request(app).delete(`/api/servers/${id}`).expect(204);
  assert.deepEqual((await request(app).get("/api/servers")).body, []);
});

test("missing master key refuses to start with stored credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-key-"));
  const store = await Store.open(directory);
  await store.save(config);
  await store.close();
  await unlink(path.join(directory, "master.key"));
  await assert.rejects(Store.open(directory), /Encryption key missing/);
  await rm(directory, { recursive: true, force: true });
});

test("server selection rejects missing, unknown, and conflicting IDs and isolates endpoints", async (t) => {
  const { app } = await fixture(t);
  const first = (await request(app).post("/api/servers").send(config)).body.id;
  const second = (
    await request(app)
      .post("/api/servers")
      .send({ ...config, endpoint_url: "http://127.0.0.1:9001" })
  ).body.id;
  await request(app).get("/api/buckets").expect(400);
  await request(app).get("/api/buckets").set("x-s3-server-id", "missing").expect(404);
  await request(app)
    .get(`/api/buckets?serverId=${second}`)
    .set("x-s3-server-id", first)
    .expect(400);
  assert.equal(
    (await request(app).get("/api/buckets").set("x-s3-server-id", first)).body.buckets[0].name,
    "documents",
  );
  assert.equal(
    (await request(app).get(`/api/buckets?serverId=${second}`)).body.buckets[0].name,
    "secondary",
  );
});

test("connection tests never save drafts and can reuse saved credentials", async (t) => {
  const { app } = await fixture(t);
  await request(app).post("/api/servers/test").send(config).expect(200);
  assert.equal((await request(app).get("/api/servers")).body.length, 0);
  const id = (await request(app).post("/api/servers").send(config)).body.id;
  const { access_key: _a, secret_key: _s, ...draft } = config;
  await request(app)
    .post("/api/servers/test")
    .send({ ...draft, id })
    .expect(200);
  const failed = await request(app)
    .post("/api/servers/test")
    .send({ ...config, secret_key: "wrong" })
    .expect(403);
  assert.ok(!JSON.stringify(failed.body).includes("credential material"));
});

test("validation rejects malformed endpoints, incomplete credentials, JSON, and cross-site changes", async (t) => {
  const { app } = await fixture(t);
  await request(app)
    .post("/api/servers")
    .send({ ...config, endpoint_url: "file:///tmp/test" })
    .expect(400);
  await request(app)
    .post("/api/servers")
    .send({ ...config, endpoint_url: "https://user:password@example.com" })
    .expect(400);
  await request(app)
    .post("/api/servers")
    .send({ ...config, secret_key: undefined })
    .expect(400);
  await request(app)
    .post("/api/servers")
    .set("Content-Type", "application/json")
    .send("{bad")
    .expect(400);
  await request(app)
    .post("/api/servers")
    .set("Origin", "https://attacker.example")
    .send(config)
    .expect(403);
  await request(app)
    .post("/api/servers")
    .set("Sec-Fetch-Site", "cross-site")
    .send(config)
    .expect(403);
});

test("folder listing, pagination, metadata, signed URLs, and exact encoded keys", async (t) => {
  const { app } = await fixture(t);
  const id = (await request(app).post("/api/servers").send(config)).body.id;
  const listed = await request(app)
    .get("/api/buckets/documents/objects")
    .query({ serverId: id, prefix: "folder/" })
    .expect(200);
  assert.equal(listed.body.objects[0].key, "folder/hello.txt");
  assert.equal(listed.body.next_token, "page-two");
  const page = await request(app)
    .get("/api/buckets/documents/objects")
    .query({ serverId: id, continuationToken: "page-two" })
    .expect(200);
  assert.equal(page.body.next_token, null);
  await request(app)
    .get("/api/buckets/documents/objects/metadata")
    .query({ serverId: id, key: "folder/space + 日本語#.txt" })
    .expect(200);
  for (const direction of ["upload", "download"]) {
    const signed = await request(app)
      .post(`/api/presigned-url/${direction}`)
      .set("x-s3-server-id", id)
      .send({
        bucket: "documents",
        key: "folder/space + 日本語#.txt",
        contentType: "text/plain",
      })
      .expect(200);
    assert.ok(signed.body.url.includes("X-Amz-Signature"));
    assert.ok(signed.body.expires_at);
    assert.ok(!signed.body.url.includes(config.secret_key));
  }
  await request(app)
    .post("/api/presigned-url/download")
    .set("x-s3-server-id", id)
    .send({ bucket: "documents", key: "test", expiresIn: 1 })
    .expect(400);
  await request(app)
    .post("/api/buckets/documents/folders")
    .set("x-s3-server-id", id)
    .send({ key: "new/" })
    .expect(201);
  await request(app)
    .post("/api/buckets/documents/folders")
    .set("x-s3-server-id", id)
    .send({ key: "invalid" })
    .expect(400);
});

test("batch deletion reports partial failures and supports more than one S3 batch", async (t) => {
  const { app } = await fixture(t);
  const id = (await request(app).post("/api/servers").send(config)).body.id;
  const keys = [...Array.from({ length: 1002 }, (_, index) => `file-${index}`), "denied"];
  const result = await request(app)
    .delete("/api/buckets/documents/objects")
    .set("x-s3-server-id", id)
    .send({ keys })
    .expect(200);
  assert.equal(result.body.deleted.length, 1002);
  assert.deepEqual(result.body.errors, [{ key: "denied", code: "AccessDenied" }]);
  await request(app)
    .delete("/api/buckets/documents/objects")
    .set("x-s3-server-id", id)
    .send({ keys: ["single"] })
    .expect(200);
});

test("backend download streams, safe previews work, and active-content previews are refused", async (t) => {
  const { app } = await fixture(t);
  const id = (await request(app).post("/api/servers").send(config)).body.id;
  const result = await request(app)
    .get("/api/stream/download")
    .query({ serverId: id, bucket: "documents", key: "hello.txt" })
    .expect(200);
  assert.equal(result.body.toString(), "hello");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.ok(result.headers["content-disposition"].startsWith("attachment"));
  const preview = await request(app)
    .get("/api/stream/download")
    .query({
      serverId: id,
      bucket: "documents",
      key: "hello.txt",
      preview: "true",
    })
    .expect(200);
  assert.equal(preview.text, "hello");
  await request(app)
    .get("/api/stream/download")
    .query({
      serverId: id,
      bucket: "documents",
      key: "unsafe.svg",
      preview: "true",
    })
    .expect(415);
});

test("raw JSON proxy uploads bypass the API JSON parser", async (t) => {
  const { app } = await fixture(t);
  const id = (await request(app).post("/api/servers").send(config)).body.id;
  await request(app)
    .put("/api/stream/upload")
    .query({ bucket: "documents", key: "raw.json" })
    .set("x-s3-server-id", id)
    .set("Content-Type", "application/json")
    .send("{not valid json, still raw bytes}")
    .expect(201);
});

test("health endpoints and unknown API paths", async (t) => {
  const { app, directory } = await fixture(t);
  await request(app).get("/api/health/live").expect(200);
  await request(app).get("/api/health/ready").expect(200);
  await request(app).get("/api/missing").expect(404);
  assert.equal((await readFile(path.join(directory, "master.key"))).length, 32);
});
