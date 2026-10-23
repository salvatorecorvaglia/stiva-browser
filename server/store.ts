import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import knex, { type Knex } from "knex";
import { CredentialCipher } from "./credentials.js";
import { HttpError } from "./errors.js";
import { serversMigration } from "./migrations/001_servers.js";

export { type ServerInput, serverInput } from "../shared/contracts.js";

import type { ServerInput } from "../shared/contracts.js";
export interface ServerRow {
  id: string;
  name: string;
  endpoint_url: string;
  region: string;
  access_key: string;
  secret_key: string;
  force_path_style: boolean | number;
  created_at: string;
  updated_at: string;
}

export class Store {
  private constructor(
    public db: Knex,
    private cipher: CredentialCipher,
  ) {}

  static async open(directory: string, databaseUri?: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (databaseUri && !["postgres:", "postgresql:"].includes(new URL(databaseUri).protocol)) {
      throw new Error("DB_URI must be a PostgreSQL connection URI");
    }
    const db = knex(
      databaseUri
        ? {
            client: "pg",
            connection: databaseUri,
            pool: { min: 0, max: 10 },
            acquireConnectionTimeout: 15000,
          }
        : {
            client: "better-sqlite3",
            connection: { filename: path.join(directory, "stiva.sqlite") },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
          },
    );
    try {
      if (!databaseUri) {
        await db.raw("PRAGMA journal_mode = WAL");
        await db.raw("PRAGMA busy_timeout = 5000");
      }
      await db.migrate.latest({
        migrationSource: {
          getMigrations: async () => ["001_servers"],
          getMigrationName: (name: string) => name,
          getMigration: async () => serversMigration,
        },
      });
      const keyPath = path.join(directory, "master.key");
      let key: Buffer;
      try {
        key = await readFile(keyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const count = await db("s3_servers").count("* as count").first();
        if (Number(count?.count))
          throw new Error(
            "Encryption key missing for existing credentials. Restore master.key from backup.",
          );
        try {
          await writeFile(keyPath, randomBytes(32), {
            flag: "wx",
            mode: 0o600,
          });
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        }
        key = await readFile(keyPath);
      }
      if (key.length !== 32) throw new Error("Invalid encryption key file");
      await chmod(keyPath, 0o600);
      if (!(await stat(keyPath)).isFile()) throw new Error("Invalid key file");
      const store = new Store(db, new CredentialCipher(key));
      for (const row of await db<ServerRow>("s3_servers")) {
        store.cipher.decrypt(row.access_key);
        store.cipher.decrypt(row.secret_key);
      }
      return store;
    } catch (error) {
      await db.destroy();
      throw error;
    }
  }

  revision(row: ServerRow) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          row.id,
          row.name,
          row.endpoint_url,
          row.region,
          row.access_key,
          row.secret_key,
          Boolean(row.force_path_style),
          row.created_at,
          row.updated_at,
        ]),
      )
      .digest("hex");
  }
  publicRow(row: ServerRow) {
    const { access_key: _access, secret_key: _secret, ...rest } = row;
    return {
      ...rest,
      revision: this.revision(row),
      force_path_style: Boolean(row.force_path_style),
      access_key: "••••••••",
      has_secret_key: true,
    };
  }
  async list() {
    return (await this.db<ServerRow>("s3_servers").orderBy("created_at")).map((row) =>
      this.publicRow(row),
    );
  }
  async row(id: string) {
    return this.db<ServerRow>("s3_servers").where({ id }).first();
  }
  credentials(row: ServerRow) {
    return {
      accessKeyId: this.cipher.decrypt(row.access_key),
      secretAccessKey: this.cipher.decrypt(row.secret_key),
    };
  }
  async save(input: ServerInput, existing?: ServerRow, expectedRevision?: string) {
    return this.db.transaction(async (trx) => {
      let current: ServerRow | undefined;
      if (existing) {
        const query = trx<ServerRow>("s3_servers").where({ id: existing.id });
        current = await (this.db.client.config.client === "pg" ? query.forUpdate() : query).first();
        if (!current) throw new HttpError(404, "S3 server not found");
        if (expectedRevision && expectedRevision !== `"${this.revision(current)}"`)
          throw new HttpError(412, "Server changed. Reload its configuration before saving.");
      }
      if (!current && (!input.access_key || !input.secret_key))
        throw new HttpError(400, "Access key and secret key are required");
      const accessKey = input.access_key
        ? this.cipher.encrypt(input.access_key)
        : current?.access_key;
      const secretKey = input.secret_key
        ? this.cipher.encrypt(input.secret_key)
        : current?.secret_key;
      if (!accessKey || !secretKey)
        throw new HttpError(400, "Access key and secret key are required");
      const row: ServerRow = {
        ...input,
        id: current?.id ?? randomUUID(),
        created_at: current?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        access_key: accessKey,
        secret_key: secretKey,
      };
      if (current) {
        const count = await trx("s3_servers").where({ id: row.id }).update(row);
        if (!count) throw new HttpError(404, "S3 server not found");
      } else await trx("s3_servers").insert(row);
      return this.publicRow(row);
    });
  }
  async close() {
    await this.db.destroy();
    this.cipher.clear();
  }
}
