import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "../server/app.js";
import { makeS3 } from "../server/s3.js";
import { Store } from "../server/store.js";

const endpoints = [process.env.STIVA_TEST_S3_A, process.env.STIVA_TEST_S3_B];
const enabled =
  endpoints.every(Boolean) &&
  !!process.env.STIVA_TEST_ACCESS_KEY &&
  !!process.env.STIVA_TEST_SECRET_KEY;

test("live S3: two servers, folders, pagination, metadata, signed and streamed transfers", {
  skip: !enabled,
  timeout: 120000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-live-"));
  const store = await Store.open(directory);
  const app = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const credentials = {
    accessKeyId: process.env.STIVA_TEST_ACCESS_KEY!,
    secretAccessKey: process.env.STIVA_TEST_SECRET_KEY!,
  };
  const buckets = [`stiva-a-${Date.now()}`, `stiva-b-${Date.now()}`];
  const clients = endpoints.map((endpoint) =>
    makeS3(
      {
        endpoint_url: endpoint!,
        region: "us-east-1",
        force_path_style: true,
      },
      credentials,
    ),
  );
  t.after(async () => {
    for (let index = 0; index < clients.length; index++) {
      const client = clients[index];
      try {
        let token: string | undefined;
        do {
          const result = await client.send(
            new ListObjectsV2Command({
              Bucket: buckets[index],
              ContinuationToken: token,
            }),
          );
          if (result.Contents?.length)
            await client.send(
              new DeleteObjectsCommand({
                Bucket: buckets[index],
                Delete: {
                  Objects: result.Contents.map((item) => ({
                    Key: item.Key!,
                  })),
                },
              }),
            );
          token = result.NextContinuationToken;
        } while (token);
        await client.send(new DeleteBucketCommand({ Bucket: buckets[index] }));
      } finally {
        client.destroy();
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < clients.length; i++)
    await clients[i].send(new CreateBucketCommand({ Bucket: buckets[i] }));
  const ids: string[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    const body = {
      name: `Server ${i}`,
      endpoint_url: endpoints[i],
      region: "us-east-1",
      access_key: credentials.accessKeyId,
      secret_key: credentials.secretAccessKey,
      force_path_style: true,
    };
    await request(app).post("/api/servers/test").send(body).expect(200);
    ids.push((await request(app).post("/api/servers").send(body).expect(201)).body.id);
    const result = await request(app).get("/api/buckets").set("x-s3-server-id", ids[i]).expect(200);
    assert.ok(result.body.buckets.some((item: { name: string }) => item.name === buckets[i]));
    assert.ok(!result.body.buckets.some((item: { name: string }) => item.name === buckets[1 - i]));
  }
  const id = ids[0];
  const bucket = buckets[0];
  await request(app)
    .post(`/api/buckets/${bucket}/folders`)
    .set("x-s3-server-id", id)
    .send({ key: "folder/" })
    .expect(201);
  const key = "folder/space + 日本語#?.txt";
  const signed = await request(app)
    .post("/api/presigned-url/upload")
    .set("x-s3-server-id", id)
    .send({ bucket, key, contentType: "text/plain" })
    .expect(200);
  const put = await fetch(signed.body.url, {
    method: "PUT",
    body: "real signed upload",
    headers: signed.body.required_headers,
  });
  assert.equal(put.status, 200, await put.text());
  const metadata = await request(app)
    .get(`/api/buckets/${bucket}/objects/metadata`)
    .query({ key, serverId: id })
    .expect(200);
  assert.equal(metadata.body.size, 18);
  assert.equal(metadata.body.content_type, "text/plain");
  const download = await request(app)
    .post("/api/presigned-url/download")
    .set("x-s3-server-id", id)
    .send({ bucket, key })
    .expect(200);
  const get = await fetch(download.body.url);
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "real signed upload");
  const proxy = await fetch(
    `${base}/api/stream/download?${new URLSearchParams({ bucket, key, serverId: id })}`,
  );
  assert.equal(await proxy.text(), "real signed upload");
  const json = "{not valid JSON: streamed verbatim}";
  const uploaded = await fetch(
    `${base}/api/stream/upload?${new URLSearchParams({ bucket, key: "stream.json" })}`,
    {
      method: "PUT",
      headers: { "x-s3-server-id": id, "Content-Type": "application/json" },
      body: json,
    },
  );
  assert.equal(uploaded.status, 201, await uploaded.text());
  const streamed = await fetch(
    `${base}/api/stream/download?${new URLSearchParams({ bucket, key: "stream.json", serverId: id })}`,
  );
  assert.equal(await streamed.text(), json);
  const largeBody = Buffer.alloc(9 * 1024 * 1024, "a");
  const large = await fetch(
    `${base}/api/stream/upload?${new URLSearchParams({ bucket, key: "multipart.bin" })}`,
    {
      method: "PUT",
      headers: {
        "x-s3-server-id": id,
        "Content-Type": "application/octet-stream",
      },
      body: largeBody,
    },
  );
  assert.equal(large.status, 201, await large.text());
  const largeDownload = await fetch(
    `${base}/api/stream/download?${new URLSearchParams({ bucket, key: "multipart.bin", serverId: id })}`,
  );
  assert.deepEqual(Buffer.from(await largeDownload.arrayBuffer()), largeBody);
  await clients[0].send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "unsafe.svg",
      Body: '<svg onload="alert(1)"/>',
      ContentType: "image/svg+xml",
    }),
  );
  await request(app)
    .get("/api/stream/download")
    .query({ bucket, key: "unsafe.svg", serverId: id, preview: "true" })
    .expect(415);
  const folder = await request(app)
    .get(`/api/buckets/${bucket}/objects`)
    .query({ serverId: id, prefix: "folder/" })
    .expect(200);
  assert.deepEqual(
    folder.body.objects.map((item: { key: string }) => item.key),
    [key],
  );
  await request(app)
    .delete(`/api/buckets/${bucket}/objects`)
    .set("x-s3-server-id", id)
    .send({ keys: ["folder/"] })
    .expect(200);
  await request(app)
    .get(`/api/buckets/${bucket}/objects/metadata`)
    .query({ key, serverId: id })
    .expect(200);
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      clients[0].send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `pages/item-${String(i).padStart(3, "0")}`,
          Body: "x",
        }),
      ),
    ),
  );
  const first = await request(app)
    .get(`/api/buckets/${bucket}/objects`)
    .query({ serverId: id, prefix: "pages/" })
    .expect(200);
  assert.equal(first.body.objects.length, 200);
  assert.ok(first.body.next_token);
  const second = await request(app)
    .get(`/api/buckets/${bucket}/objects`)
    .query({
      serverId: id,
      prefix: "pages/",
      continuationToken: first.body.next_token,
    })
    .expect(200);
  assert.equal(second.body.objects.length, 5);
  assert.equal(second.body.next_token, null);
  await request(app)
    .delete(`/api/buckets/${bucket}/objects`)
    .set("x-s3-server-id", id)
    .send({ keys: [key, "folder/"] })
    .expect(200);
});
