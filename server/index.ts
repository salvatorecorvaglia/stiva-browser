import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { Store } from "./store.js";

const directory = path.resolve(process.env.DATA_DIR ?? "./data");
const port = Number(process.env.PORT ?? 3000);
try {
  const store = await Store.open(directory, process.env.DB_URI);
  const app = createApp(store, {
    staticDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web"),
  });
  const server = app.listen(port, "0.0.0.0", () =>
    console.log(`Stiva Browser listening on http://localhost:${port}`),
  );
  server.requestTimeout = 0;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => {
      server.closeAllConnections();
    }, 15000);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      void store.close().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(
    "Stiva Browser could not initialize its database or encryption key. Check data-directory permissions and restore the matching key if needed.",
  );
  if (process.env.NODE_ENV !== "production")
    console.error(error instanceof Error ? error.message : "Initialization failed");
  process.exitCode = 1;
}
