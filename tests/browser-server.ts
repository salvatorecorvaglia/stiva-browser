import { rm } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";

const directory = path.resolve("test-results/browser-data");
await rm(directory, { recursive: true, force: true });
const store = await Store.open(directory);
const server = createApp(store, {
  staticDirectory: path.resolve("dist/web"),
}).listen(4173, "127.0.0.1");
const stop = () =>
  server.close(() => {
    void store.close().then(() => process.exit(0));
  });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
