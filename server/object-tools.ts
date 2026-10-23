import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { Express, Request } from "express";
import { z } from "zod";
import {
  folderSchema as folder,
  keySchema as key,
  versionIdSchema as versionId,
} from "../shared/contracts.js";
import { deleteKeys } from "./deletion.js";
import { HttpError } from "./errors.js";
import { requestSignal } from "./resources.js";
import { restoreVersion } from "./restore.js";

type Using = <T>(req: Request, run: (client: S3Client) => Promise<T>) => Promise<T>;
const versionAction = z
  .object({ key, versionId, confirmation: z.string() })
  .refine(
    (value) => value.confirmation === value.key,
    "Confirmation must match the complete object key",
  );
interface Snapshot {
  serverId: string;
  scope: string;
  bucket: string;
  prefix: string;
  keys: string[];
  expires: number;
}

export function registerObjectTools(
  app: Express,
  using: Using,
  selectedId: (req: Request) => string,
  clientScope: (client: S3Client) => string,
  limits: {
    preview: <T>(run: () => Promise<T>) => Promise<T>;
    restore: <T>(run: () => Promise<T>) => Promise<T>;
  },
) {
  const snapshots = new Map<string, Snapshot>();
  const clean = () => {
    for (const [id, item] of snapshots) if (item.expires <= Date.now()) snapshots.delete(id);
  };

  app.get("/api/buckets/:bucket/folders/delete-preview", async (req, res) => {
    await limits.preview(async () => {
      clean();
      if (snapshots.size >= 100)
        throw new HttpError(429, "Too many deletion previews. Wait five minutes and retry.");
      const prefix = folder.parse(req.query.prefix);
      const bucket = z.string().min(1).parse(req.params.bucket);
      const { objects, scope } = await using(req, async (client) => {
        const all: { key: string; size: number }[] = [];
        let token: string | undefined;
        const seen = new Set<string>();
        const signal = AbortSignal.timeout(60000);
        do {
          const result = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ContinuationToken: token,
              MaxKeys: 1000,
            }),
            { abortSignal: signal },
          );
          for (const object of result.Contents ?? []) {
            if (object.Key?.startsWith(prefix))
              all.push({ key: object.Key, size: object.Size ?? 0 });
          }
          if (all.length > 10000)
            throw new HttpError(
              413,
              "Folder exceeds 10,000 objects. Delete smaller subfolders instead. No objects were deleted.",
            );
          token = result.NextContinuationToken;
          if (token && seen.has(token))
            throw new HttpError(502, "Storage repeated a pagination token");
          if (token) seen.add(token);
          if (result.IsTruncated && !token)
            throw new HttpError(502, "Storage omitted a required pagination token");
        } while (token);
        return {
          objects: [...new Map(all.map((item) => [item.key, item])).values()],
          scope: clientScope(client),
        };
      });
      clean();
      const retainedKeys = [...snapshots.values()].reduce(
        (count, item) => count + item.keys.length,
        0,
      );
      if (snapshots.size >= 100 || retainedKeys + objects.length > 20000)
        throw new HttpError(429, "Too many active deletion previews. Wait five minutes and retry.");
      const token = randomUUID();
      const expires = Date.now() + 5 * 60 * 1000;
      snapshots.set(token, {
        serverId: selectedId(req),
        scope,
        bucket,
        prefix,
        keys: objects.map((item) => item.key),
        expires,
      });
      res.json({
        preview_token: token,
        prefix,
        count: objects.length,
        size: objects.reduce((sum, item) => sum + item.size, 0),
        sample: objects.slice(0, 20).map((item) => item.key),
        expires_at: new Date(expires).toISOString(),
      });
    });
  });

  app.delete("/api/buckets/:bucket/folders", async (req, res) => {
    const input = z
      .object({
        prefix: folder,
        confirmation: z.string(),
        preview_token: z.string().uuid(),
      })
      .parse(req.body);
    if (input.confirmation !== input.prefix)
      throw new HttpError(400, "Type the complete folder prefix to confirm deletion");
    clean();
    const snapshot = snapshots.get(input.preview_token);
    if (
      !snapshot ||
      snapshot.serverId !== selectedId(req) ||
      snapshot.bucket !== req.params.bucket ||
      snapshot.prefix !== input.prefix
    )
      throw new HttpError(
        409,
        "Deletion preview expired or does not match this folder and server. Preview again.",
      );
    const result = await using(req, async (client) => {
      if (snapshot.scope !== clientScope(client))
        throw new HttpError(
          409,
          "Server configuration changed. Preview this folder again before deleting.",
        );
      // Consume before the first write so concurrent submissions cannot repeat a versioned delete.
      if (snapshots.get(input.preview_token) !== snapshot)
        throw new HttpError(409, "Deletion preview was already submitted. Preview again.");
      snapshots.delete(input.preview_token);
      return deleteKeys(client, snapshot.bucket, snapshot.keys, undefined, true);
    });
    res.json(result);
  });

  app.get("/api/buckets/:bucket/versions", async (req, res) => {
    const input = z
      .object({
        prefix: z.string().default(""),
        key: key.optional(),
        keyMarker: z.string().optional(),
        versionIdMarker: versionId.optional(),
      })
      .refine(
        (value) => !value.versionIdMarker || !!value.keyMarker,
        "A version marker requires a key marker",
      )
      .parse(req.query);
    const result = await using(req, (client) =>
      client.send(
        new ListObjectVersionsCommand({
          Bucket: z.string().parse(req.params.bucket),
          Prefix: input.key ?? input.prefix,
          KeyMarker: input.keyMarker,
          VersionIdMarker: input.versionIdMarker,
          MaxKeys: 200,
        }),
      ),
    );
    const versions = [
      ...(result.Versions ?? []).map((item) => ({
        key: item.Key,
        version_id: item.VersionId,
        is_latest: item.IsLatest ?? false,
        is_delete_marker: false,
        size: item.Size ?? 0,
        last_modified: item.LastModified,
        etag: item.ETag,
      })),
      ...(result.DeleteMarkers ?? []).map((item) => ({
        key: item.Key,
        version_id: item.VersionId,
        is_latest: item.IsLatest ?? false,
        is_delete_marker: true,
        size: 0,
        last_modified: item.LastModified,
      })),
    ].filter((item) => item.key && item.version_id && (!input.key || item.key === input.key));
    versions.sort((a, b) => {
      const byKey = (a.key ?? "").localeCompare(b.key ?? "");
      return (
        byKey ||
        Number(b.is_latest) - Number(a.is_latest) ||
        (b.last_modified?.getTime() ?? 0) - (a.last_modified?.getTime() ?? 0)
      );
    });
    if (result.IsTruncated && !result.NextKeyMarker)
      throw new HttpError(502, "Storage omitted a version pagination marker");
    // Providers may append opaque state to key markers (including MinIO cache tokens).
    // Exact-key scoping comes from Prefix and result filtering, never marker spelling.
    const reachedNeighbors =
      input.key &&
      [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])].some(
        (item) => item.Key && item.Key !== input.key,
      );
    const more = result.IsTruncated && result.NextKeyMarker && !reachedNeighbors;
    if (
      more &&
      result.NextKeyMarker === input.keyMarker &&
      result.NextVersionIdMarker === input.versionIdMarker
    )
      throw new HttpError(502, "Storage repeated a version pagination marker");
    res.json({
      versions,
      next_key_marker: more ? result.NextKeyMarker : null,
      next_version_id_marker: more ? (result.NextVersionIdMarker ?? null) : null,
    });
  });

  app.delete("/api/buckets/:bucket/versions", async (req, res) => {
    const input = versionAction.parse(req.body);
    await using(req, (client) =>
      client.send(
        new DeleteObjectCommand({
          Bucket: z.string().parse(req.params.bucket),
          Key: input.key,
          VersionId: input.versionId,
        }),
      ),
    );
    res.json({ deleted: true, key: input.key, version_id: input.versionId });
  });

  app.post("/api/buckets/:bucket/versions/restore", async (req, res) => {
    const input = versionAction.parse(req.body);
    const bucket = z.string().parse(req.params.bucket);
    await limits.restore(async () => {
      const operation = requestSignal(req);
      try {
        const result = await using(req, (client) =>
          restoreVersion(client, bucket, input.key, input.versionId, operation.signal),
        );
        res.status(201).json({ key: input.key, version_id: result.VersionId ?? null });
      } finally {
        operation.dispose();
      }
    });
  });
}
