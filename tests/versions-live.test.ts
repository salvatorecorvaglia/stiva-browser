import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "../server/app.js";
import { makeS3 } from "../server/s3.js";
import { Store } from "../server/store.js";

test("live versioned S3: history, restore, permanent deletes, markers, pagination, and recursive snapshots", {
  skip: !process.env.STIVA_TEST_VERSIONED_S3,
  timeout: 120000,
}, async (t) => {
  const endpoint = process.env.STIVA_TEST_VERSIONED_S3!;
  const credentials = {
    accessKeyId: process.env.STIVA_TEST_ACCESS_KEY ?? "fixture-access",
    secretAccessKey: process.env.STIVA_TEST_SECRET_KEY ?? "fixture-secret",
  };
  const client = makeS3(
    { endpoint_url: endpoint, region: "us-east-1", force_path_style: true },
    credentials,
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-versions-"));
  const store = await Store.open(directory);
  const app = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bucket = `stiva-versions-${randomUUID()}`;
  let created = false;
  t.after(async () => {
    try {
      if (created) {
        const all: { Key: string; VersionId: string }[] = [];
        let keyMarker: string | undefined;
        let versionMarker: string | undefined;
        do {
          const result = await client.send(
            new ListObjectVersionsCommand({
              Bucket: bucket,
              KeyMarker: keyMarker,
              VersionIdMarker: versionMarker,
            }),
          );
          all.push(
            ...[...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])].map((item) => ({
              Key: item.Key!,
              VersionId: item.VersionId!,
            })),
          );
          keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
          versionMarker = result.NextVersionIdMarker;
        } while (keyMarker);
        for (let i = 0; i < all.length; i += 1000)
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: all.slice(i, i + 1000) },
            }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  created = true;
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const id = (
    await request(app)
      .post("/api/servers")
      .send({
        name: "Versioned fixture",
        endpoint_url: endpoint,
        region: "us-east-1",
        access_key: credentials.accessKeyId,
        secret_key: credentials.secretAccessKey,
        force_path_style: true,
      })
      .expect(201)
  ).body.id;
  const key = "folder/old + 日本語.txt";
  const old = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: "old contents",
      ContentType: "text/plain",
      Metadata: { source: "original" },
      Tagging: "label=original",
    }),
  );
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: "new contents",
      ContentType: "text/plain",
    }),
  );
  const signed = (
    await request(app)
      .post("/api/presigned-url/download")
      .set("x-s3-server-id", id)
      .send({ bucket, key, versionId: old.VersionId })
      .expect(200)
  ).body;
  assert.equal(await (await fetch(signed.url)).text(), "old contents");
  const marker = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  const history = await request(app)
    .get(`/api/buckets/${bucket}/versions`)
    .query({ key })
    .set("x-s3-server-id", id)
    .expect(200);
  assert.equal(history.body.versions.length, 3);
  assert.ok(history.body.versions.some((v: any) => v.is_delete_marker && v.is_latest));
  const stream = await fetch(
    `${base}/api/stream/download?${new URLSearchParams({ bucket, key, serverId: id, versionId: old.VersionId! })}`,
  );
  assert.equal(stream.status, 200);
  assert.equal(await stream.text(), "old contents");
  const restored = await request(app)
    .post(`/api/buckets/${bucket}/versions/restore`)
    .set("x-s3-server-id", id)
    .send({ key, versionId: old.VersionId, confirmation: key })
    .expect(201);
  assert.ok(restored.body.version_id && restored.body.version_id !== old.VersionId);
  const meta = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  assert.equal(meta.Metadata?.source, "original");
  const tags = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
  assert.deepEqual(tags.TagSet, [{ Key: "label", Value: "original" }]);
  await request(app)
    .delete(`/api/buckets/${bucket}/versions`)
    .set("x-s3-server-id", id)
    .send({ key, versionId: old.VersionId, confirmation: key })
    .expect(200);
  await request(app)
    .get(`/api/buckets/${bucket}/objects/metadata`)
    .query({ key, versionId: old.VersionId })
    .set("x-s3-server-id", id)
    .expect(404);
  await request(app)
    .delete(`/api/buckets/${bucket}/versions`)
    .set("x-s3-server-id", id)
    .send({ key, versionId: marker.VersionId, confirmation: key })
    .expect(200);
  const current = await fetch(
    `${base}/api/stream/download?${new URLSearchParams({ bucket, key, serverId: id })}`,
  );
  assert.equal(await current.text(), "old contents");
  for (let batch = 0; batch < 205; batch += 20)
    await Promise.all(
      Array.from({ length: Math.min(20, 205 - batch) }, (_, i) =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: "paged.txt",
            Body: `version-${batch + i}`,
          }),
        ),
      ),
    );
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "paged.txt-neighbor",
      Body: "neighbor",
    }),
  );
  const page = (
    await request(app)
      .get(`/api/buckets/${bucket}/versions`)
      .query({ key: "paged.txt" })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  assert.equal(page.versions.length, 200);
  assert.ok(page.next_key_marker);
  const next = (
    await request(app)
      .get(`/api/buckets/${bucket}/versions`)
      .query({
        key: "paged.txt",
        keyMarker: page.next_key_marker,
        versionIdMarker: page.next_version_id_marker,
      })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  assert.equal(next.versions.length, 5);
  assert.equal(next.next_key_marker, null);
  for (const folderKey of [
    "nested/",
    "nested/a.txt",
    "nested/deep/b.txt",
    "nested-sibling/outside.txt",
  ])
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: folderKey,
        Body: "content",
      }),
    );
  const preview = (
    await request(app)
      .get(`/api/buckets/${bucket}/folders/delete-preview`)
      .query({ prefix: "nested/" })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  assert.equal(preview.count, 3);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "nested/added-after-preview.txt",
      Body: "retained",
    }),
  );
  const deleted = (
    await request(app)
      .delete(`/api/buckets/${bucket}/folders`)
      .set("x-s3-server-id", id)
      .send({
        prefix: "nested/",
        confirmation: "nested/",
        preview_token: preview.preview_token,
      })
      .expect(200)
  ).body;
  assert.equal(deleted.deleted.length, 3);
  assert.equal(deleted.errors.length, 0);
  await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: "nested/added-after-preview.txt",
    }),
  );
  await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: "nested-sibling/outside.txt",
    }),
  );
  const retained = (
    await request(app)
      .get(`/api/buckets/${bucket}/versions`)
      .query({ prefix: "nested/" })
      .set("x-s3-server-id", id)
      .expect(200)
  ).body;
  assert.ok(retained.versions.some((v: any) => v.key === "nested/a.txt" && !v.is_delete_marker));
  assert.ok(retained.versions.some((v: any) => v.key === "nested/a.txt" && v.is_delete_marker));
});
