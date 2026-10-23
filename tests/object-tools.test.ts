import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { type TestContext, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "../server/app.js";
import { restoreVersion } from "../server/restore.js";
import { Store } from "../server/store.js";
import { type S3Call as Call, mockSend, required, type S3Handler } from "./helpers.js";

const config = {
  name: "Fixture",
  endpoint_url: "http://127.0.0.1:9000",
  region: "us-east-1",
  access_key: "fixture",
  secret_key: "fixture-secret",
  force_path_style: true,
};
async function fixture(t: TestContext, handler: S3Handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-tools-"));
  const store = await Store.open(directory);
  const calls: Call[] = [];
  const app = createApp(store, {
    clientFactory: (input, credentials) => {
      const client = new S3Client({
        endpoint: input.endpoint_url,
        region: input.region,
        forcePathStyle: true,
        credentials,
      });
      mockSend(client, (call) => {
        calls.push(call);
        return handler(call);
      });
      return client;
    },
  });
  const id = (await request(app).post("/api/servers").send(config).expect(201)).body.id;
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, store, id, calls };
}

test("recursive deletion previews all pages, binds a one-use snapshot, and reports partial failures", async (t) => {
  const { app, id, calls } = await fixture(t, ({ name, input }) => {
    if (name === "ListObjectsV2Command")
      return input.ContinuationToken
        ? {
            Contents: [
              { Key: "folder/nested/b.txt", Size: 9 },
              { Key: "folder/denied", Size: 1 },
            ],
          }
        : {
            Contents: [
              { Key: "folder/", Size: 0 },
              { Key: "folder/a.txt", Size: 5 },
            ],
            IsTruncated: true,
            NextContinuationToken: "page2",
          };
    if (name === "DeleteObjectsCommand")
      return {
        Deleted: required(input.Delete?.Objects).filter((item) => item.Key !== "folder/denied"),
        Errors: [{ Key: "folder/denied", Code: "AccessDenied" }],
      };
    throw new Error(name);
  });
  const preview = await request(app)
    .get("/api/buckets/data/folders/delete-preview")
    .query({ prefix: "folder/" })
    .set("x-s3-server-id", id)
    .expect(200);
  assert.equal(preview.body.count, 4);
  assert.equal(preview.body.size, 15);
  assert.ok(!calls.some((call) => call.name.startsWith("Delete")));
  const body = {
    prefix: "folder/",
    confirmation: "folder/",
    preview_token: preview.body.preview_token,
  };
  await request(app)
    .delete("/api/buckets/data/folders")
    .set("x-s3-server-id", id)
    .send({ ...body, confirmation: "folder" })
    .expect(400);
  await request(app)
    .delete("/api/buckets/other/folders")
    .set("x-s3-server-id", id)
    .send(body)
    .expect(409);
  const result = await request(app)
    .delete("/api/buckets/data/folders")
    .set("x-s3-server-id", id)
    .send(body)
    .expect(200);
  assert.deepEqual(result.body.deleted, ["folder/", "folder/a.txt", "folder/nested/b.txt"]);
  assert.deepEqual(result.body.errors, [{ key: "folder/denied", code: "AccessDenied" }]);
  const listed = calls.filter((call) => call.name === "ListObjectsV2Command");
  assert.equal(listed.length, 2);
  assert.equal(listed[0].input.Delimiter, undefined);
  await request(app)
    .delete("/api/buckets/data/folders")
    .set("x-s3-server-id", id)
    .send(body)
    .expect(409);
  await request(app)
    .get("/api/buckets/data/folders/delete-preview")
    .query({ prefix: "" })
    .set("x-s3-server-id", id)
    .expect(400);
});

test("recursive deletion rejects server edits, repeated tokens, and oversized folders before writes", async (t) => {
  let scenario = "normal";
  const { app, id, calls } = await fixture(t, ({ name }) => {
    if (name !== "ListObjectsV2Command") throw new Error("No writes expected");
    if (scenario === "oversized")
      return {
        Contents: Array.from({ length: 10001 }, (_, index) => ({
          Key: `folder/${index}`,
          Size: 1,
        })),
      };
    return {
      Contents: [{ Key: "folder/a" }],
      ...(scenario === "repeated" ? { IsTruncated: true, NextContinuationToken: "same" } : {}),
    };
  });
  const preview = (
    await request(app)
      .get("/api/buckets/data/folders/delete-preview")
      .query({ prefix: "folder/" })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  await request(app)
    .put(`/api/servers/${id}`)
    .send({ ...config, endpoint_url: "http://127.0.0.1:9001" })
    .expect(200);
  await request(app)
    .delete("/api/buckets/data/folders")
    .set("x-s3-server-id", id)
    .send({
      prefix: "folder/",
      confirmation: "folder/",
      preview_token: preview.preview_token,
    })
    .expect(409);
  scenario = "repeated";
  await request(app)
    .get("/api/buckets/data/folders/delete-preview")
    .query({ prefix: "folder/" })
    .set("x-s3-server-id", id)
    .expect(502);
  scenario = "oversized";
  await request(app)
    .get("/api/buckets/data/folders/delete-preview")
    .query({ prefix: "folder/" })
    .set("x-s3-server-id", id)
    .expect(413);
  assert.ok(!calls.some((call) => call.name.startsWith("Delete")));
});

test("recursive deletion chunks at 1000 and includes failed batches in the result", async (t) => {
  let batch = 0;
  const { app, id, calls } = await fixture(t, ({ name, input }) => {
    if (name === "ListObjectsV2Command")
      return {
        Contents: Array.from({ length: 2005 }, (_, i) => ({
          Key: `folder/${i}`,
        })),
      };
    if (name === "DeleteObjectsCommand") {
      if (++batch === 2) throw new Error("upstream failure");
      return { Deleted: required(input.Delete?.Objects) };
    }
    throw new Error(name);
  });
  const preview = (
    await request(app)
      .get("/api/buckets/data/folders/delete-preview")
      .query({ prefix: "folder/" })
      .set("x-s3-server-id", id)
  ).body;
  const result = await request(app)
    .delete("/api/buckets/data/folders")
    .set("x-s3-server-id", id)
    .send({
      prefix: "folder/",
      confirmation: "folder/",
      preview_token: preview.preview_token,
    })
    .expect(200);
  assert.equal(result.body.deleted.length, 1005);
  assert.equal(result.body.errors.length, 1000);
  assert.deepEqual(
    calls
      .filter((call) => call.name === "DeleteObjectsCommand")
      .map((call) => required(call.input.Delete?.Objects).length),
    [1000, 1000, 5],
  );
});

test("version history returns markers, preserves pagination, and scopes exact keys", async (t) => {
  const { app, id, calls } = await fixture(t, ({ name, input }) => {
    assert.equal(name, "ListObjectVersionsCommand");
    return {
      Versions: [
        { Key: "a.txt", VersionId: "v1", Size: 8 },
        ...(input.KeyMarker ? [{ Key: "a.txt-neighbor", VersionId: "neighbor" }] : []),
      ],
      DeleteMarkers: [{ Key: "a.txt", VersionId: "marker", IsLatest: true }],
      IsTruncated: !input.KeyMarker,
      NextKeyMarker: "a.txt",
      NextVersionIdMarker: "v1",
    };
  });
  const result = await request(app)
    .get("/api/buckets/data/versions")
    .query({ key: "a.txt" })
    .set("x-s3-server-id", id)
    .expect(200);
  assert.equal(result.body.versions.length, 2);
  assert.equal(result.body.versions[0].is_delete_marker, true);
  assert.equal(result.body.next_key_marker, "a.txt");
  assert.equal(result.body.next_version_id_marker, "v1");
  await request(app)
    .get("/api/buckets/data/versions")
    .query({ key: "a.txt", keyMarker: "a.txt", versionIdMarker: "v1" })
    .set("x-s3-server-id", id)
    .expect(200);
  const continued = required(calls[1]);
  assert.equal(continued.name, "ListObjectVersionsCommand");
  assert.equal(continued.input.VersionIdMarker, "v1");
  await request(app)
    .get("/api/buckets/data/versions")
    .query({ key: "a.txt", keyMarker: "a.txt[minio_cache:v2,return:]", versionIdMarker: "v1" })
    .set("x-s3-server-id", id)
    .expect(200);
});

test("version delete requires exact confirmation, restore copies the selected version, and reads retain versionId", async (t) => {
  const { app, id, calls } = await fixture(t, ({ name }) => {
    if (name === "HeadObjectCommand")
      return {
        ContentLength: 5,
        ContentType: "text/plain",
        ETag: "source-etag",
      };
    if (name === "CopyObjectCommand") return { VersionId: "new-version" };
    if (name === "GetObjectCommand")
      return {
        Body: Readable.from(["hello"]),
        ContentLength: 5,
        ContentType: "text/plain",
      };
    if (name === "DeleteObjectCommand") return {};
    throw new Error(name);
  });
  const body = {
    key: "folder/space + 日本語.txt",
    versionId: "old+id",
    confirmation: "folder/space + 日本語.txt",
  };
  await request(app)
    .delete("/api/buckets/data/versions")
    .set("x-s3-server-id", id)
    .send({ ...body, confirmation: "wrong" })
    .expect(400);
  await request(app)
    .delete("/api/buckets/data/versions")
    .set("x-s3-server-id", id)
    .send(body)
    .expect(200);
  const removed = required(calls[0]);
  assert.equal(removed.name, "DeleteObjectCommand");
  assert.equal(removed.input.VersionId, "old+id");
  const result = await request(app)
    .post("/api/buckets/data/versions/restore")
    .set("x-s3-server-id", id)
    .send(body)
    .expect(201);
  assert.equal(result.body.version_id, "new-version");
  const copy = required(calls.find((call) => call.name === "CopyObjectCommand"));
  assert.equal(
    copy.input.CopySource,
    "data/folder/space%20%2B%20%E6%97%A5%E6%9C%AC%E8%AA%9E.txt?versionId=old%2Bid",
  );
  const signed = await request(app)
    .post("/api/presigned-url/download")
    .set("x-s3-server-id", id)
    .send({ bucket: "data", key: body.key, versionId: body.versionId })
    .expect(200);
  assert.equal(new URL(signed.body.url).searchParams.get("versionId"), "old+id");
  await request(app)
    .get("/api/stream/download")
    .query({
      bucket: "data",
      key: body.key,
      versionId: body.versionId,
      serverId: id,
    })
    .expect(200);
  assert.equal(
    required(calls.find((call) => call.name === "GetObjectCommand")).input.VersionId,
    "old+id",
  );
  await request(app)
    .post("/api/presigned-url/upload")
    .set("x-s3-server-id", id)
    .send({ bucket: "data", key: "a", versionId: "old" })
    .expect(400);
});

test("large restore copies bounded ranges and aborts failed multipart copies", async () => {
  const calls: Call[] = [];
  let fail = false;
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
  });
  const size = 5 * 1024 ** 3 + 1;
  mockSend(client, (call) => {
    const { name, input } = call;
    calls.push(call);
    if (name === "HeadObjectCommand")
      return {
        ContentLength: size,
        ContentType: "video/mp4",
        Metadata: { owner: "fixture" },
      };
    if (name === "GetObjectTaggingCommand")
      return { TagSet: [{ Key: "label", Value: "old version" }] };
    if (name === "CreateMultipartUploadCommand") return { UploadId: "upload" };
    if (name === "UploadPartCopyCommand") {
      if (fail && input.PartNumber === 2) throw new Error("copy failed");
      return { CopyPartResult: { ETag: `part-${input.PartNumber}` } };
    }
    if (name === "CompleteMultipartUploadCommand") return { VersionId: "restored" };
    if (name === "AbortMultipartUploadCommand") return {};
    throw new Error(name);
  });
  try {
    const result = await restoreVersion(
      client,
      "bucket",
      "large.bin",
      "v1",
      new AbortController().signal,
    );
    assert.equal(result.VersionId, "restored");
    const parts = calls.filter((call) => call.name === "UploadPartCopyCommand");
    assert.equal(parts.length, 81);
    assert.equal(parts[0].input.CopySourceRange, "bytes=0-67108863");
    assert.equal(required(parts.at(-1)).input.CopySourceRange, `bytes=${size - 1}-${size - 1}`);
    assert.equal(
      required(calls.find((call) => call.name === "CreateMultipartUploadCommand")).input.Tagging,
      "label=old+version",
    );
    fail = true;
    calls.length = 0;
    await assert.rejects(
      restoreVersion(client, "bucket", "large.bin", "v1", new AbortController().signal),
      /copy failed/,
    );
    assert.ok(calls.some((call) => call.name === "AbortMultipartUploadCommand"));
    assert.ok(!calls.some((call) => call.name === "CompleteMultipartUploadCommand"));
  } finally {
    client.destroy();
  }
});

test("deletion previews cannot be submitted concurrently or after expiration", async (t) => {
  const { app, id, calls } = await fixture(t, async ({ name, input }) => {
    if (name === "ListObjectsV2Command") return { Contents: [{ Key: "folder/a.txt", Size: 1 }] };
    if (name === "DeleteObjectsCommand") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { Deleted: required(input.Delete?.Objects) };
    }
    throw new Error(name);
  });
  const preview = (
    await request(app)
      .get("/api/buckets/data/folders/delete-preview")
      .query({ prefix: "folder/" })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  const body = {
    prefix: "folder/",
    confirmation: "folder/",
    preview_token: preview.preview_token,
  };
  const results = await Promise.all([
    request(app).delete("/api/buckets/data/folders").set("x-s3-server-id", id).send(body),
    request(app).delete("/api/buckets/data/folders").set("x-s3-server-id", id).send(body),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(calls.filter((call) => call.name === "DeleteObjectsCommand").length, 1);
  const second = (
    await request(app)
      .get("/api/buckets/data/folders/delete-preview")
      .query({ prefix: "folder/" })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 6 * 60 * 1000);
  await request(app)
    .delete("/api/buckets/data/folders")
    .set("x-s3-server-id", id)
    .send({ ...body, preview_token: second.preview_token })
    .expect(409);
  assert.equal(calls.filter((call) => call.name === "DeleteObjectsCommand").length, 1);
});
