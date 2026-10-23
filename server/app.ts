import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z, ZodError } from "zod";
import {
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Store, serverInput, type ServerInput } from "./store.js";
import { makeS3 } from "./s3.js";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const keySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => Buffer.byteLength(key) <= 1024, "Key exceeds 1024 bytes");
const objectInput = z.object({ bucket: z.string().min(1), key: keySchema });
const signingInput = objectInput.extend({
  expiresIn: z.number().int().min(60).max(3600).default(900),
  contentType: z.string().max(256).optional(),
});
const parameter = (value: unknown) => z.string().min(1).parse(value);
export type ClientFactory = typeof makeS3;

export function createApp(
  store: Store,
  options: { clientFactory?: ClientFactory; staticDirectory?: string } = {},
) {
  const app = express();
  const factory = options.clientFactory ?? makeS3;
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "connect-src": ["'self'", "http:", "https:"],
          "img-src": ["'self'", "blob:", "data:"],
        },
      },
    }),
  );
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (
        req.get("sec-fetch-site") === "cross-site" ||
        (origin && new URL(origin).host !== req.get("host"))
      )
        return next(
          new HttpError(403, "Cross-origin changes are not permitted"),
        );
    }
    next();
  });
  const json = express.json({ limit: "64kb" });
  app.use((req, res, next) =>
    req.path === "/api/stream/upload" ? next() : json(req, res, next),
  );

  app.get("/api/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/health/ready", async (_req, res) => {
    await store.db.raw("SELECT 1");
    res.json({ status: "ok" });
  });

  async function selected(req: Request) {
    const header = req.get("x-s3-server-id");
    const query =
      req.query.serverId === undefined
        ? undefined
        : parameter(req.query.serverId);
    if (header && query && header !== query)
      throw new HttpError(400, "Conflicting server identifiers");
    const id = header || query;
    if (!id) throw new HttpError(400, "Select an S3 server");
    const row = await store.row(id);
    if (!row) throw new HttpError(404, "S3 server not found");
    return factory(
      { ...row, force_path_style: Boolean(row.force_path_style) },
      store.credentials(row),
    );
  }
  async function using<T>(req: Request, run: (client: S3Client) => Promise<T>) {
    const client = await selected(req);
    try {
      return await run(client);
    } finally {
      client.destroy();
    }
  }
  async function config(body: unknown, id?: string) {
    const input = serverInput.parse(body);
    const existing = id ? await store.row(id) : undefined;
    if (id && !existing) throw new HttpError(404, "S3 server not found");
    if (!existing && (!input.access_key || !input.secret_key))
      throw new HttpError(400, "Access key and secret key are required");
    if (input.access_key?.includes("••••"))
      throw new HttpError(
        400,
        "Enter the actual access key or omit it to retain the stored key",
      );
    return { input, existing };
  }
  app.get("/api/servers", async (_req, res) => {
    res.json(await store.list());
  });
  app.post("/api/servers/test", async (req, res) => {
    const { input, existing } = await config(
      req.body,
      req.body?.id === undefined ? undefined : parameter(req.body.id),
    );
    const saved = existing ? store.credentials(existing) : undefined;
    const client = factory(input, {
      accessKeyId: input.access_key ?? saved!.accessKeyId,
      secretAccessKey: input.secret_key ?? saved!.secretAccessKey,
    });
    try {
      const result = await client.send(new ListBucketsCommand({}), {
        abortSignal: AbortSignal.timeout(15000),
      });
      res.json({ connected: true, bucket_count: result.Buckets?.length ?? 0 });
    } finally {
      client.destroy();
    }
  });
  app.post("/api/servers", async (req, res) => {
    const { input } = await config(req.body);
    res.status(201).json(await store.save(input));
  });
  app.put("/api/servers/:id", async (req, res) => {
    const { input, existing } = await config(
      req.body,
      parameter(req.params.id),
    );
    res.json(await store.save(input, existing));
  });
  app.delete("/api/servers/:id", async (req, res) => {
    const deleted = await store
      .db("s3_servers")
      .where({ id: req.params.id })
      .delete();
    if (!deleted) throw new HttpError(404, "S3 server not found");
    res.status(204).end();
  });

  app.get("/api/buckets", async (req, res) => {
    const buckets = await using(req, async (client) => {
      const all = [];
      let token: string | undefined;
      do {
        const result = await client.send(
          new ListBucketsCommand({ ContinuationToken: token }),
        );
        all.push(...(result.Buckets ?? []));
        token = result.ContinuationToken;
      } while (token);
      return all.map((b) => ({ name: b.Name, created_at: b.CreationDate }));
    });
    res.json({ buckets });
  });
  app.get("/api/buckets/:bucket/objects", async (req, res) => {
    const query = z
      .object({
        prefix: z.string().default(""),
        delimiter: z.literal("/").default("/"),
        continuationToken: z.string().optional(),
      })
      .parse(req.query);
    const result = await using(req, (client) =>
      client.send(
        new ListObjectsV2Command({
          Bucket: parameter(req.params.bucket),
          Prefix: query.prefix,
          Delimiter: query.delimiter,
          ContinuationToken: query.continuationToken,
          MaxKeys: 200,
        }),
      ),
    );
    res.json({
      objects: (result.Contents ?? [])
        .filter((o) => o.Key !== query.prefix)
        .map((o) => ({
          key: o.Key,
          size: o.Size ?? 0,
          last_modified: o.LastModified,
          etag: o.ETag,
        })),
      prefixes: (result.CommonPrefixes ?? []).map((p) => p.Prefix),
      next_token: result.NextContinuationToken ?? null,
    });
  });
  app.get("/api/buckets/:bucket/objects/metadata", async (req, res) => {
    const result = await using(req, (client) =>
      client.send(
        new HeadObjectCommand({
          Bucket: parameter(req.params.bucket),
          Key: keySchema.parse(req.query.key),
        }),
      ),
    );
    res.json({
      size: result.ContentLength,
      content_type: result.ContentType,
      last_modified: result.LastModified,
      etag: result.ETag,
      metadata: result.Metadata ?? {},
      storage_class: result.StorageClass ?? "STANDARD",
    });
  });
  for (const direction of ["download", "upload"] as const) {
    app.post(`/api/presigned-url/${direction}`, async (req, res) => {
      const input = signingInput.parse(req.body);
      const command =
        direction === "download"
          ? new GetObjectCommand({
              Bucket: input.bucket,
              Key: input.key,
              ResponseContentDisposition: disposition(input.key),
            })
          : new PutObjectCommand({
              Bucket: input.bucket,
              Key: input.key,
              ContentType: input.contentType ?? "application/octet-stream",
            });
      const url = await using(req, (client) =>
        getSignedUrl(client, command, {
          expiresIn: input.expiresIn,
          signableHeaders:
            direction === "upload" ? new Set(["content-type"]) : undefined,
        }),
      );
      res.json({
        url,
        expires_at: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
        required_headers:
          direction === "upload"
            ? {
                "Content-Type": input.contentType ?? "application/octet-stream",
              }
            : {},
      });
    });
  }
  app.post("/api/buckets/:bucket/folders", async (req, res) => {
    const key = keySchema.parse(req.body?.key);
    if (!key.endsWith("/"))
      throw new HttpError(400, "Folder keys must end with /");
    await using(req, (client) =>
      client.send(
        new PutObjectCommand({
          Bucket: parameter(req.params.bucket),
          Key: key,
          Body: Buffer.alloc(0),
          ContentLength: 0,
          ContentType: "application/x-directory",
        }),
      ),
    );
    res.status(201).json({ key });
  });
  app.delete("/api/buckets/:bucket/objects", async (req, res) => {
    const { keys } = z
      .object({ keys: z.array(keySchema).min(1).max(10000) })
      .parse(req.body);
    const result = await using(req, async (client) => {
      const bucket = parameter(req.params.bucket);
      if (keys.length === 1) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: keys[0] }),
        );
        return { deleted: keys, errors: [] };
      }
      const deleted: string[] = [];
      const errors: { key: string | undefined; code: string | undefined }[] =
        [];
      for (let start = 0; start < keys.length; start += 1000) {
        const output = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })),
            },
          }),
        );
        deleted.push(
          ...(output.Deleted ?? []).flatMap((item) =>
            item.Key ? [item.Key] : [],
          ),
        );
        errors.push(
          ...(output.Errors ?? []).map((item) => ({
            key: item.Key,
            code: item.Code,
          })),
        );
      }
      return { deleted, errors };
    });
    res.json(result);
  });

  app.get("/api/stream/download", async (req, res) => {
    const input = objectInput.parse(req.query);
    const preview = req.query.preview === "true";
    await using(req, async (client) => {
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableFinished) controller.abort();
      };
      res.on("close", abort);
      try {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            ...(preview ? { Range: "bytes=0-1048575" } : {}),
          }),
          { abortSignal: controller.signal },
        );
        if (!(output.Body instanceof Readable))
          throw new HttpError(502, "Storage did not return an object stream");
        const mime = (output.ContentType ?? "").split(";")[0].toLowerCase();
        if (
          preview &&
          ![
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
            "text/plain",
            "text/csv",
            "application/json",
          ].includes(mime)
        ) {
          output.Body.destroy();
          throw new HttpError(415, "Preview is unavailable for this file type");
        }
        if (preview && (output.ContentLength ?? 0) > 1048576) {
          output.Body.destroy();
          throw new HttpError(
            413,
            "Storage returned a preview larger than 1 MiB",
          );
        }
        res.setHeader(
          "Content-Type",
          preview ? mime : "application/octet-stream",
        );
        res.setHeader(
          "Content-Disposition",
          preview ? "inline" : disposition(input.key),
        );
        if (output.ContentLength !== undefined)
          res.setHeader("Content-Length", output.ContentLength);
        if (preview) {
          let length = 0;
          const limit = new Transform({
            transform(chunk, _encoding, callback) {
              length += chunk.length;
              callback(
                length > 1048576
                  ? new HttpError(413, "Preview exceeds 1 MiB")
                  : null,
                length <= 1048576 ? chunk : undefined,
              );
            },
          });
          await pipeline(output.Body, limit, res);
        } else await pipeline(output.Body, res);
      } finally {
        res.off("close", abort);
      }
    });
  });
  app.put("/api/stream/upload", async (req, res) => {
    const input = objectInput.parse(req.query);
    await using(req, async (client) => {
      const upload = new Upload({
        client,
        params: {
          Bucket: input.bucket,
          Key: input.key,
          Body: req,
          ContentType: req.get("content-type") ?? "application/octet-stream",
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      const abort = () => {
        void upload.abort();
      };
      const closed = () => {
        if (!res.writableFinished) abort();
      };
      req.once("aborted", abort);
      res.once("close", closed);
      try {
        await upload.done();
      } finally {
        req.off("aborted", abort);
        res.off("close", closed);
      }
    });
    res.status(201).json({ key: input.key });
  });

  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "API route not found")),
  );
  if (options.staticDirectory) {
    app.use(express.static(options.staticDirectory));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.join(options.staticDirectory!, "index.html")),
    );
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ZodError) {
        res
          .status(400)
          .json({
            error: {
              code: "VALIDATION_ERROR",
              message: error.issues
                .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
                .join("; "),
            },
          });
        return;
      }
      if (error instanceof HttpError) {
        res
          .status(error.status)
          .json({ error: { code: "REQUEST_ERROR", message: error.message } });
        return;
      }
      const upstream = error as {
        name?: string;
        type?: string;
        status?: number;
        $metadata?: { httpStatusCode?: number };
      };
      const status = upstream.$metadata?.httpStatusCode;
      const mapped =
        status === 403
          ? 403
          : status === 404
            ? 404
            : upstream.type === "entity.parse.failed"
              ? 400
              : upstream.type === "entity.too.large"
                ? 413
                : 502;
      const message =
        mapped === 403
          ? "S3 access denied. Check credentials and permissions."
          : mapped === 404
            ? "S3 bucket or object not found."
            : mapped === 400
              ? "Invalid JSON request."
              : mapped === 413
                ? "Request body too large."
                : "Unable to complete the storage request. Check endpoint, region, connectivity, and permissions.";
      res
        .status(mapped)
        .json({
          error: {
            code: mapped === 502 ? "STORAGE_ERROR" : "REQUEST_ERROR",
            message,
          },
        });
    },
  );
  return app;
}

function disposition(key: string) {
  const name = key.split("/").pop() || "download";
  return `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;
}
