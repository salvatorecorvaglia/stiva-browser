import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import path from "node:path";
import knex, { type Knex } from "knex";
import { z } from "zod";

export const serverInput = z.object({
  name: z.string().trim().min(1).max(120),
  endpoint_url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use an HTTP(S) endpoint without credentials, query parameters, or fragments"),
  region: z.string().trim().min(1).max(100).default("us-east-1"),
  access_key: z.string().min(1).max(1024).optional(),
  secret_key: z.string().min(1).max(4096).optional(),
  force_path_style: z.boolean().default(true),
});
export type ServerInput = z.infer<typeof serverInput>;
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
    private key: Buffer,
  ) {}

  static async open(directory: string, databaseUri?: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      databaseUri &&
      !["postgres:", "postgresql:"].includes(new URL(databaseUri).protocol)
    ) {
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
          getMigration: async () => ({
            up: async (connection: Knex) =>
              connection.schema.createTable("s3_servers", (table) => {
                table.string("id").primary();
                table.string("name").notNullable();
                table.text("endpoint_url").notNullable();
                table.string("region").notNullable();
                table.text("access_key").notNullable();
                table.text("secret_key").notNullable();
                table.boolean("force_path_style").notNullable().defaultTo(true);
                table.string("created_at").notNullable();
                table.string("updated_at").notNullable();
              }),
            down: async (connection: Knex) =>
              connection.schema.dropTable("s3_servers"),
          }),
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
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
            throw writeError;
        }
        key = await readFile(keyPath);
      }
      if (key.length !== 32) throw new Error("Invalid encryption key file");
      await chmod(keyPath, 0o600);
      if (!(await stat(keyPath)).isFile()) throw new Error("Invalid key file");
      const store = new Store(db, key);
      for (const row of await db<ServerRow>("s3_servers")) {
        store.decrypt(row.access_key);
        store.decrypt(row.secret_key);
      }
      return store;
    } catch (error) {
      await db.destroy();
      throw error;
    }
  }

  private encrypt(value: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("stiva:credential:v1"));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }
  private decrypt(value: string) {
    const [version, nonce, tag, ciphertext] = value.split(":");
    if (version !== "v1" || !nonce || !tag || !ciphertext)
      throw new Error("Invalid encrypted credential");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(nonce, "base64"),
    );
    cipher.setAAD(Buffer.from("stiva:credential:v1"));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      cipher.update(Buffer.from(ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8");
  }
  publicRow(row: ServerRow) {
    const { access_key: _access, secret_key: _secret, ...rest } = row;
    return {
      ...rest,
      force_path_style: Boolean(row.force_path_style),
      access_key: "••••••••",
      has_secret_key: true,
    };
  }
  async list() {
    return (await this.db<ServerRow>("s3_servers").orderBy("created_at")).map(
      (row) => this.publicRow(row),
    );
  }
  async row(id: string) {
    return this.db<ServerRow>("s3_servers").where({ id }).first();
  }
  credentials(row: ServerRow) {
    return {
      accessKeyId: this.decrypt(row.access_key),
      secretAccessKey: this.decrypt(row.secret_key),
    };
  }
  async save(input: ServerInput, existing?: ServerRow) {
    const now = new Date().toISOString();
    const row: ServerRow = {
      ...input,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      access_key: input.access_key
        ? this.encrypt(input.access_key)
        : existing!.access_key,
      secret_key: input.secret_key
        ? this.encrypt(input.secret_key)
        : existing!.secret_key,
    };
    if (existing) await this.db("s3_servers").where({ id: row.id }).update(row);
    else await this.db("s3_servers").insert(row);
    return this.publicRow(row);
  }
  async close() {
    await this.db.destroy();
    this.key.fill(0);
  }
}
