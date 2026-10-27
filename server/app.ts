import path from "node:path";
import {
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { ZodError, z } from "zod";
import { keySchema, serverInput } from "../shared/contracts.js";
import { deleteKeys } from "./deletion.js";
import { HttpError } from "./errors.js";
import { registerObjectTools } from "./object-tools.js";
import { admission, originGuard, positiveInteger, requestSignal } from "./resources.js";
import { makeS3 } from "./s3.js";
import type { Store } from "./store.js";
import { Telemetry } from "./telemetry.js";
import { disposition, registerDownload, registerUpload } from "./transfers.js";

const objectInput = z.object({ bucket: z.string().min(1), key: keySchema });
const versionedObjectInput = objectInput.extend({
  versionId: z.string().min(1).max(2048).optional(),
});
const signingInput = versionedObjectInput.extend({
  expiresIn: z.number().int().min(60).max(3600).default(900),
  contentType: z.string().max(256).optional(),
});
const parameter = (value: unknown) => z.string().min(1).parse(value);
export type ClientFactory = typeof makeS3;

export function createApp(
  store: Store,
  options: {
    desktopToken?: string;
    clientFactory?: ClientFactory;
    staticDirectory?: string;
    apiLimit?: number;
    trustProxy?: string | false;
    uploadLimit?: number;
    restoreLimit?: number;
    previewLimit?: number;
  } = {},
) {
  const app = express();
  const factory = options.clientFactory ?? makeS3;
  const clientScopes = new WeakMap<S3Client, string>();
  const inFlight = new Set<Promise<unknown>>();
  app.locals.waitForStorage = async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  };
  app.disable("x-powered-by");
  if (options.desktopToken) {
    const token = options.desktopToken;
    app.use((req, res, next) => {
      if (req.get("x-stiva-desktop-token") !== token) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Desktop session required" } });
        return;
      }
      next();
    });
  }
  const telemetry = new Telemetry();
  app.use(telemetry.httpMiddleware);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY;
  if (trustProxy && trustProxy !== "false") {
    if (trustProxy === "true")
      throw new Error("TRUST_PROXY must specify trusted proxy addresses or CIDRs, not true");
    app.set(
      "trust proxy",
      trustProxy.split(",").map((value) => value.trim()),
    );
  }
  const uploadAdmission = admission(
    options.uploadLimit ?? positiveInteger(process.env.MAX_CONCURRENT_UPLOADS, 4),
    "upload",
    telemetry,
  );
  const restoreAdmission = admission(
    options.restoreLimit ?? positiveInteger(process.env.MAX_CONCURRENT_RESTORES, 2),
    "restore",
    telemetry,
  );
  const previewAdmission = admission(
    options.previewLimit ?? positiveInteger(process.env.MAX_CONCURRENT_PREVIEWS, 2),
    "folder-preview",
    telemetry,
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "connect-src": ["'self'", "http:", "https:"],
          "img-src": ["'self'", "blob:", "data:"],
          // TLS redirects belong to the ingress; upgrading breaks supported local HTTP in Safari.
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", originGuard);
  app.get("/api/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/health/ready", async (_req, res) => {
    await store.db.raw("SELECT 1");
    res.json({ status: "ok" });
  });

  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: options.apiLimit ?? positiveInteger(process.env.API_RATE_LIMIT, 600),
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: { code: "RATE_LIMITED", message: "Too many API requests. Retry shortly." },
      },
    }),
  );

  async function selected(req: Request) {
    const header = req.get("x-s3-server-id");
    const query = req.query.serverId === undefined ? undefined : parameter(req.query.serverId);
    if (header && query && header !== query)
      throw new HttpError(400, "Conflicting server identifiers");
    const id = header || query;
    if (!id) throw new HttpError(400, "Select an S3 server");
    const row = await store.row(id);
    if (!row) throw new HttpError(404, "S3 server not found");
    const client = factory(
      { ...row, force_path_style: Boolean(row.force_path_style) },
      store.credentials(row),
    );
    clientScopes.set(client, store.revision(row));
    return client;
  }
  function using<T>(req: Request, run: (client: S3Client) => Promise<T>): Promise<T> {
    const task = (async () => {
      const client = await selected(req);
      const operation = requestSignal(req);
      const send = client.send.bind(client);
      // Apply disconnect cancellation to every command, retaining any stricter command deadline.
      client.send = ((
        command: Parameters<S3Client["send"]>[0],
        settings?: { abortSignal?: AbortSignal },
      ) =>
        send(command, {
          ...settings,
          abortSignal:
            command instanceof AbortMultipartUploadCommand
              ? settings?.abortSignal
              : settings?.abortSignal
                ? AbortSignal.any([operation.signal, settings.abortSignal])
                : operation.signal,
        })) as S3Client["send"];
      try {
        return await run(client);
      } finally {
        operation.dispose();
        client.destroy();
      }
    })();
    inFlight.add(task);
    return task.finally(() => {
      inFlight.delete(task);
    });
  }
  async function config(body: unknown, id?: string) {
    const input = serverInput.parse(body);
    const existing = id ? await store.row(id) : undefined;
    if (id && !existing) throw new HttpError(404, "S3 server not found");
    if (!existing && (!input.access_key || !input.secret_key))
      throw new HttpError(400, "Access key and secret key are required");
    if (input.access_key?.includes("••••"))
      throw new HttpError(400, "Enter the actual access key or omit it to retain the stored key");
    return { input, existing };
  }
  registerUpload(app, using, uploadAdmission);
  app.use(express.json({ limit: "64kb" }));
  app.get("/api/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4; charset=utf-8").send(telemetry.render());
  });
  registerObjectTools(
    app,
    using,
    (req) => req.get("x-s3-server-id") || parameter(req.query.serverId),
    (client) => {
      const scope = clientScopes.get(client);
      if (!scope) throw new HttpError(502, "Storage configuration scope is unavailable");
      return scope;
    },
    { preview: previewAdmission, restore: restoreAdmission },
  );
  app.get("/api/servers", async (_req, res) => {
    res.json(await store.list());
  });
  app.post("/api/servers/test", async (req, res) => {
    const { input, existing } = await config(
      req.body,
      req.body?.id === undefined ? undefined : parameter(req.body.id),
    );
    const saved = existing ? store.credentials(existing) : undefined;
    const accessKeyId = input.access_key ?? saved?.accessKeyId;
    const secretAccessKey = input.secret_key ?? saved?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey)
      throw new HttpError(400, "Access key and secret key are required");
    const client = factory(input, { accessKeyId, secretAccessKey });
    const operation = requestSignal(req, 15000);
    try {
      const result = await client.send(new ListBucketsCommand({ MaxBuckets: 1000 }), {
        abortSignal: operation.signal,
      });
      res.json({
        connected: true,
        bucket_count: result.Buckets?.length ?? 0,
        has_more: Boolean(result.ContinuationToken),
      });
    } finally {
      operation.dispose();
      client.destroy();
    }
  });
  app.post("/api/servers", async (req, res) => {
    const { input } = await config(req.body);
    res.status(201).json(await store.save(input));
  });
  app.put("/api/servers/:id", async (req, res) => {
    const { input, existing } = await config(req.body, parameter(req.params.id));
    res.json(await store.save(input, existing, req.get("if-match")));
  });
  app.delete("/api/servers/:id", async (req, res) => {
    const deleted = await store.db("s3_servers").where({ id: req.params.id }).delete();
    if (!deleted) throw new HttpError(404, "S3 server not found");
    res.status(204).end();
  });

  app.get("/api/buckets", async (req, res) => {
    const buckets = await using(req, async (client) => {
      const all = [];
      let token: string | undefined;
      const seen = new Set<string>();
      const deadline = AbortSignal.timeout(60000);
      do {
        const result = await client.send(
          new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }),
          { abortSignal: deadline },
        );
        all.push(...(result.Buckets ?? []));
        token = result.ContinuationToken;
        if (token && seen.has(token))
          throw new HttpError(502, "Storage repeated a bucket pagination token");
        if (token) seen.add(token);
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
          VersionId: z.string().min(1).max(2048).optional().parse(req.query.versionId),
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
      if (direction === "upload" && input.versionId)
        throw new HttpError(
          400,
          "Uploads create a new version; versionId is only supported for downloads",
        );
      const command =
        direction === "download"
          ? new GetObjectCommand({
              Bucket: input.bucket,
              Key: input.key,
              VersionId: input.versionId,
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
          signableHeaders: direction === "upload" ? new Set(["content-type"]) : undefined,
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
    if (!key.endsWith("/")) throw new HttpError(400, "Folder keys must end with /");
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
    const { keys } = z.object({ keys: z.array(keySchema).min(1).max(10000) }).parse(req.body);
    const result = await using(req, (client) =>
      deleteKeys(client, parameter(req.params.bucket), keys),
    );
    res.json(result);
  });

  registerDownload(app, using);

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "API route not found")));
  const staticDirectory = options.staticDirectory;
  if (staticDirectory) {
    // Share one per-client budget across assets and the SPA fallback before filesystem access.
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 300,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: { code: "RATE_LIMITED", message: "Too many requests, try again later" } },
      }),
    );
    app.use(express.static(staticDirectory));
    app.get("/{*path}", (_req, res) => res.sendFile(path.join(staticDirectory, "index.html")));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError && error.code === "MULTIPART_CLEANUP_FAILED") {
      telemetry.cleanupFailed();
      if (process.env.NODE_ENV === "production")
        console.error(JSON.stringify({ event: "multipart_cleanup_failed", status: error.status }));
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
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
      if (error.status === 429) res.setHeader("Retry-After", "5");
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
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
      status === 501
        ? 501
        : status === 403
          ? 403
          : status === 404
            ? 404
            : upstream.type === "entity.parse.failed"
              ? 400
              : upstream.type === "entity.too.large"
                ? 413
                : 502;
    const message =
      mapped === 501
        ? "This S3 endpoint does not support the requested operation."
        : mapped === 403
          ? "S3 access denied. Check credentials and permissions."
          : mapped === 404
            ? "S3 bucket or object not found."
            : mapped === 400
              ? "Invalid JSON request."
              : mapped === 413
                ? "Request body too large."
                : "Unable to complete the storage request. Check endpoint, region, connectivity, and permissions.";
    res.status(mapped).json({
      error: {
        code: mapped === 502 ? "STORAGE_ERROR" : "REQUEST_ERROR",
        message,
      },
    });
  });
  return app;
}
