import { access } from "node:fs/promises";
import path from "node:path";
import { type ServerRow, Store } from "./store.js";

const uri = process.env.DB_URI;
if (!uri) throw new Error("Set DB_URI to the destination PostgreSQL database");
const directory = path.resolve(process.env.DATA_DIR ?? "./data");
await access(path.join(directory, "stiva.sqlite"));
await access(path.join(directory, "master.key"));
const source = await Store.open(directory);
let target: Store | undefined;
try {
  const rows = await source.db<ServerRow>("s3_servers").select("*");
  target = await Store.open(directory, uri);
  await target.db.transaction(async (trx) => {
    await trx.raw("LOCK TABLE s3_servers IN EXCLUSIVE MODE");
    const count = await trx("s3_servers").count("* as count").first();
    if (Number(count?.count)) throw new Error("Destination must be empty; no records were changed");
    for (let offset = 0; offset < rows.length; offset += 500) {
      await trx("s3_servers").insert(
        rows.slice(offset, offset + 500).map((row) => ({
          ...row,
          force_path_style: Boolean(row.force_path_style),
        })),
      );
    }
  });
  console.log(
    `Copied ${rows.length} encrypted server configurations. Keep the existing master.key and restart with DB_URI. SQLite was retained.`,
  );
} catch {
  console.error(
    "Migration failed. Verify the database connection, destination is empty, and DATA_DIR contains the matching key. No credentials are logged.",
  );
  process.exitCode = 1;
} finally {
  await target?.close();
  await source.close();
}
