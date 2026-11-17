import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { serverInput } from "../shared/contracts.js";

const entry = serverInput
  .omit({ access_key: true, secret_key: true })
  .extend({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    access_key_file: z.string().min(1),
    secret_key_file: z.string().min(1),
  })
  .strict();
const schema = z.object({ servers: z.array(entry) }).strict();

export async function loadManagedServers(file?: string) {
  if (!file) return [];
  try {
    const config = schema.parse(JSON.parse(await readFile(file, "utf8")));
    if (new Set(config.servers.map((server) => server.id)).size !== config.servers.length)
      throw new Error("Duplicate IDs");
    return await Promise.all(
      config.servers.map(async (server) => {
        const { access_key_file, secret_key_file, ...settings } = server;
        const readCredential = async (name: string) => {
          const value = await readFile(path.resolve(path.dirname(file), name), "utf8");
          return value.replace(/\r?\n$/, "");
        };
        return {
          ...serverInput.parse({
            ...settings,
            access_key: await readCredential(access_key_file),
            secret_key: await readCredential(secret_key_file),
          }),
          id: settings.id,
        };
      }),
    );
  } catch {
    // Do not include parser errors: they can contain credential material.
    throw new Error("Cannot load managed S3 servers: check configuration and credential files");
  }
}
