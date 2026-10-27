import { once } from "node:events";
import { createApp } from "./app.js";
import { Store } from "./store.js";

/** Private, ephemeral HTTP transport for the sandboxed desktop renderer. */
export async function startDesktop(directory: string, staticDirectory: string, token: string) {
  if (token.length < 32) throw new Error("Desktop token is too short");
  const store = await Store.open(directory);
  const app = createApp(store, { staticDirectory, desktopToken: token, trustProxy: false });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    await store.close();
    throw error;
  }
  server.requestTimeout = 0;
  server.setTimeout(60000);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Desktop listener unavailable");
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      closing ??= (async () => {
        const force = setTimeout(() => server.closeAllConnections(), 15000);
        force.unref();
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
          await app.locals.waitForStorage();
          await store.close();
        } finally {
          clearTimeout(force);
        }
      })();
      return closing;
    },
  };
}
