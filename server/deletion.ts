import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { DeletionResult } from "../shared/contracts.js";

/** Never discard earlier results or claim a deletion without an acknowledgment. */
export async function deleteKeys(
  client: S3Client,
  bucket: string,
  input: string[],
  signal?: AbortSignal,
): Promise<DeletionResult> {
  const keys = [...new Set(input)];
  const result: DeletionResult = { deleted: [], errors: [] };
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const batch = keys.slice(offset, offset + 1000);
    try {
      if (keys.length === 1) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: batch[0] }), {
          abortSignal: signal,
        });
        result.deleted.push(batch[0]);
      } else {
        const command = new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
        });
        // Older S3-compatible providers require MD5 rather than the SDK's CRC32 default.
        // Hash the serialized XML before signing so escaping and encoding match exactly.
        command.middlewareStack.add(
          (next) => async (args) => {
            const request = args.request as { body: string; headers: Record<string, string> };
            request.headers["content-md5"] = createHash("md5")
              .update(request.body)
              .digest("base64");
            return next(args);
          },
          { step: "build", name: "deleteContentMd5" },
        );
        const output = await client.send(command, { abortSignal: signal });
        const confirmed = new Set((output.Deleted ?? []).map((item) => item.Key));
        const errors = new Map(
          (output.Errors ?? []).map((item) => [item.Key, item.Code ?? "StorageError"]),
        );
        for (const key of batch) {
          if (confirmed.has(key) && !errors.has(key)) result.deleted.push(key);
          else result.errors.push({ key, code: errors.get(key) ?? "UnconfirmedDeletion" });
        }
      }
    } catch (error) {
      const code =
        error instanceof S3ServiceException && error.$metadata.httpStatusCode !== undefined
          ? error.name
          : "UnconfirmedDeletion";
      result.errors.push(...batch.map((key) => ({ key, code })));
    }
  }
  return result;
}
