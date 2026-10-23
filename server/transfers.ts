import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Express, Request } from "express";
import { z } from "zod";
import { keySchema, versionIdSchema } from "../shared/contracts.js";
import { HttpError } from "./errors.js";
import { requestSignal } from "./resources.js";
import { uploadObject } from "./upload.js";

type Using = <T>(req: Request, run: (client: S3Client) => Promise<T>) => Promise<T>;
const objectInput = z.object({ bucket: z.string().min(1), key: keySchema });
const versionedObjectInput = objectInput.extend({ versionId: versionIdSchema.optional() });
export function registerUpload(
  app: Express,
  using: Using,
  uploadAdmission: <T>(run: () => Promise<T>) => Promise<T>,
) {
  app.put("/api/stream/upload", async (req, res) => {
    const input = objectInput.parse(req.query);
    await uploadAdmission(async () => {
      const operation = requestSignal(req);
      const idle = () => req.destroy(new Error("Upload idle timeout"));
      req.setTimeout(60000, idle);
      try {
        await using(req, (client) =>
          uploadObject(
            client,
            {
              ...input,
              contentType: req.get("content-type") ?? "application/octet-stream",
              length:
                req.get("content-length") === undefined
                  ? undefined
                  : Number(req.get("content-length")),
            },
            req,
            operation.signal,
          ),
        );
      } finally {
        req.off("timeout", idle);
        req.setTimeout(0);
        operation.dispose();
      }
    });
    res.status(201).json({ key: input.key });
  });
}
export function registerDownload(app: Express, using: Using) {
  app.get("/api/stream/download", async (req, res) => {
    const input = versionedObjectInput.parse(req.query);
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
            VersionId: input.versionId,
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
          throw new HttpError(413, "Storage returned a preview larger than 1 MiB");
        }
        res.setHeader("Content-Type", preview ? mime : "application/octet-stream");
        res.setHeader("Content-Disposition", preview ? "inline" : disposition(input.key));
        if (output.ContentLength !== undefined)
          res.setHeader("Content-Length", output.ContentLength);
        if (preview) {
          let length = 0;
          const limit = new Transform({
            transform(chunk, _encoding, callback) {
              length += chunk.length;
              callback(
                length > 1048576 ? new HttpError(413, "Preview exceeds 1 MiB") : null,
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
}

export function disposition(key: string) {
  const name = key.split("/").pop() || "download";
  return `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;
}
