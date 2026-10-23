import { rm } from "node:fs/promises";
import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import express from "express";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { mockSend } from "./helpers.js";

const directory = path.resolve("test-results/browser-data");
await rm(directory, { recursive: true, force: true });
const store = await Store.open(directory);
let uploaded = Buffer.alloc(0);
const harness = express();
// Loopback-only test fixture: verify actual browser File bytes at the HTTP receiver.
harness.get("/__test/upload", (_req, res) => res.type("text/plain").send(uploaded));
harness.use(
  createApp(store, {
    staticDirectory: path.resolve("dist/web"),
    clientFactory: () => {
      const client = new S3Client({ region: "us-east-1" });
      mockSend(client, ({ name, input }) => {
        if (name !== "PutObjectCommand" || !(input.Body instanceof Uint8Array))
          throw new Error("Unexpected unmocked storage request");
        uploaded = Buffer.from(input.Body);
        return { ETag: "browser-fixture" };
      });
      return client;
    },
  }),
);
const server = harness.listen(4173, "127.0.0.1");
const stop = () =>
  server.close(() => {
    void store.close().then(() => process.exit(0));
  });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
