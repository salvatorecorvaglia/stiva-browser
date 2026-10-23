import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, get, request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { type ClientFactory, createApp } from "../server/app.js";
import { makeS3 } from "../server/s3.js";
import { Store } from "../server/store.js";

const config = {
  name: "Network fixture",
  endpoint_url: "http://example.invalid",
  region: "us-east-1",
  access_key: "fixture",
  secret_key: "fixture-secret",
  force_path_style: true,
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server: Server, t: TestContext) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function storeFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-network-"));
  const store = await Store.open(directory);
  const saved = await store.save(config);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, saved };
}
function mockedClient(
  run: (name: string, signal?: AbortSignal) => Promise<unknown>,
): ClientFactory {
  return () => {
    const client = new S3Client({
      region: config.region,
      credentials: { accessKeyId: config.access_key, secretAccessKey: config.secret_key },
    });
    client.send = ((
      command: { constructor: { name: string } },
      options?: { abortSignal?: AbortSignal },
    ) => run(command.constructor.name, options?.abortSignal)) as unknown as S3Client["send"];
    return client;
  };
}

test("S3 request deadlines terminate hanging upstream requests", { timeout: 10000 }, async (t) => {
  const endpoint = await listen(
    createServer(() => {}),
    t,
  );
  const client = makeS3(
    { ...config, endpoint_url: endpoint },
    { accessKeyId: config.access_key, secretAccessKey: config.secret_key },
  );
  const handler = client.config.requestHandler;
  assert.ok(
    "updateHttpClientConfig" in handler && typeof handler.updateHttpClientConfig === "function",
  );
  handler.updateHttpClientConfig("requestTimeout", 20);
  t.after(() => client.destroy());
  await assert.rejects(
    client.send(new ListBucketsCommand({ MaxBuckets: 1000 })),
    (error) => error instanceof Error && error.name === "TimeoutError",
  );
});

test("disconnecting a read cancels its S3 work", { timeout: 10000 }, async (t) => {
  const { store, saved } = await storeFixture(t);
  const started = deferred();
  const stopped = deferred();
  const app = createApp(store, {
    clientFactory: mockedClient(
      (_name, signal) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          signal?.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    ),
  });
  const base = await listen(createServer(app), t);
  const outgoing = get(`${base}/api/buckets?serverId=${saved.id}`);
  outgoing.on("error", () => {});
  await started.promise;
  outgoing.destroy();
  await stopped.promise;
});

test("HTTP upload cancellation awaits cleanup with an independent abort signal", {
  timeout: 10000,
}, async (t) => {
  const { store, saved } = await storeFixture(t);
  const started = deferred();
  const cleaned = deferred();
  const releaseCleanup = deferred();
  let active = 0;
  const app = createApp(store, {
    clientFactory: mockedClient(async (name, signal) => {
      if (name === "CreateMultipartUploadCommand") return { UploadId: "fixture" };
      if (name === "UploadPartCommand") {
        active++;
        try {
          return await new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("cancelled"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            started.resolve();
          });
        } finally {
          active--;
        }
      }
      assert.equal(name, "AbortMultipartUploadCommand");
      assert.equal(active, 0);
      assert.equal(signal?.aborted, false);
      cleaned.resolve();
      await releaseCleanup.promise;
      return {};
    }),
  });
  const base = await listen(createServer(app), t);
  const outgoing = httpRequest(
    `${base}/api/stream/upload?serverId=${saved.id}&bucket=fixture&key=large`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(17 * 1024 ** 2),
      },
    },
  );
  outgoing.on("error", () => {});
  outgoing.write(Buffer.alloc(16 * 1024 ** 2));
  await started.promise;
  outgoing.destroy();
  await cleaned.promise;
  let drained = false;
  const draining = app.locals.waitForStorage().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  releaseCleanup.resolve();
  await draining;
  assert.equal(drained, true);
});

test("folder scans are admitted before storage work starts", { timeout: 10000 }, async (t) => {
  const { store, saved } = await storeFixture(t);
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const app = createApp(store, {
    previewLimit: 1,
    clientFactory: mockedClient(async () => {
      calls++;
      started.resolve();
      await release.promise;
      return { Contents: [] };
    }),
  });
  const first = request(app)
    .get("/api/buckets/fixture/folders/delete-preview")
    .query({ prefix: "folder/", serverId: saved.id })
    .then((response) => response);
  await started.promise;
  await request(app)
    .get("/api/buckets/fixture/folders/delete-preview")
    .query({ prefix: "folder/", serverId: saved.id })
    .expect(429);
  assert.equal(calls, 1);
  release.resolve();
  assert.equal((await first).status, 200);
});
