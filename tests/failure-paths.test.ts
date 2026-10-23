import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "../server/app.js";
import { admission } from "../server/resources.js";
import { restoreVersion } from "../server/restore.js";
import { Store } from "../server/store.js";
import { Telemetry } from "../server/telemetry.js";
import { mockSend, type S3Handler } from "./helpers.js";

function clientFor(handler: S3Handler) {
  const client = new S3Client({ region: "us-east-1" });
  mockSend(client, handler);
  return client;
}
test("restore rejects malformed source metadata before copying or allocating an upload", async () => {
  for (const metadata of [
    { DeleteMarker: true },
    {},
    { ContentLength: -1 },
    { ContentLength: NaN },
    { ContentLength: 0.5 },
  ]) {
    let calls = 0;
    const client = clientFor(({ name }) => {
      calls++;
      assert.equal(name, "HeadObjectCommand");
      return metadata;
    });
    try {
      await assert.rejects(
        restoreVersion(client, "bucket", "key", "version", new AbortController().signal),
      );
      assert.equal(calls, 1);
    } finally {
      client.destroy();
    }
  }
});
test("large restore rejects malformed tags and missing upload IDs", async () => {
  for (const invalidTags of [true, false]) {
    const client = clientFor(({ name }) => {
      if (name === "HeadObjectCommand") return { ContentLength: 6 * 1024 ** 3 };
      if (name === "GetObjectTaggingCommand")
        return { TagSet: invalidTags ? [{ Key: "missing value" }] : [] };
      assert.equal(name, "CreateMultipartUploadCommand");
      return {};
    });
    try {
      await assert.rejects(
        restoreVersion(client, "bucket", "key", "version", new AbortController().signal),
        /invalid object tag|upload identifier/,
      );
    } finally {
      client.destroy();
    }
  }
});
test("restore settles sibling copies before independent cleanup even after cancellation", async () => {
  for (const cleanupFails of [false, true]) {
    const controller = new AbortController();
    let settled = 0;
    let copies = 0;
    const client = clientFor(async ({ name }, signal) => {
      if (name === "HeadObjectCommand") return { ContentLength: 6 * 1024 ** 3 };
      if (name === "GetObjectTaggingCommand") return {};
      if (name === "CreateMultipartUploadCommand") return { UploadId: "fixture" };
      if (name === "UploadPartCopyCommand") {
        copies++;
        if (copies === 1) {
          controller.abort();
          settled++;
          throw new Error("copy failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled++;
        return {};
      }
      assert.equal(name, "AbortMultipartUploadCommand");
      assert.equal(settled, 2);
      assert.notEqual(signal, controller.signal);
      assert.equal(signal?.aborted, false);
      if (cleanupFails) throw new Error("cleanup failed");
      return {};
    });
    try {
      await assert.rejects(
        restoreVersion(client, "bucket", "key", "version", controller.signal),
        cleanupFails ? /cleanup could not be confirmed/ : /copy failed/,
      );
    } finally {
      client.destroy();
    }
  }
});
test("telemetry counts admission outcomes and exposes bounded route labels without object keys", async (t) => {
  const telemetry = new Telemetry();
  const run = admission(1, "upload", telemetry);
  let release = () => {};
  const pending = run(
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
  await pending;
  await assert.rejects(
    run(async () => {
      throw new Error("failure");
    }),
  );
  telemetry.cleanupFailed();
  const rendered = telemetry.render();
  for (const [metric, value] of [
    ["active", 0],
    ["peak", 1],
    ["completed_total", 1],
    ["failed_total", 1],
    ["rejected_total", 1],
  ])
    assert.ok(rendered.includes(`stiva_storage_${metric}{operation="upload"} ${value}`));
  assert.ok(rendered.includes("stiva_multipart_cleanup_failures_total 1"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-metrics-"));
  const store = await Store.open(directory);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const app = createApp(store);
  await request(app).get("/api/private-object-key?credential=fixture-secret").expect(404);
  const response = await request(app).get("/api/metrics").expect(200);
  assert.match(response.headers["content-type"], /text\/plain/);
  assert.match(response.headers["cache-control"], /no-store/);
  assert.doesNotMatch(response.text, /private-object-key|fixture-secret|credential=/);
  assert.match(response.text, /route="unmatched"/);
});
