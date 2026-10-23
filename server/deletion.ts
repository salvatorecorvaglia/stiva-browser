import { DeleteObjectCommand, DeleteObjectsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { DeletionResult } from "../shared/contracts.js";

/** Never discard earlier results or claim a deletion without an acknowledgment. */
export async function deleteKeys(
  client: S3Client,
  bucket: string,
  input: string[],
  signal?: AbortSignal,
  bulkOnly = false,
): Promise<DeletionResult> {
  const keys = [...new Set(input)];
  const result: DeletionResult = { deleted: [], errors: [] };
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const batch = keys.slice(offset, offset + 1000);
    try {
      if (keys.length === 1 && !bulkOnly) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: batch[0] }), {
          abortSignal: signal,
        });
        result.deleted.push(batch[0]);
      } else {
        const output = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
          { abortSignal: signal },
        );
        const confirmed = new Set((output.Deleted ?? []).map((item) => item.Key));
        const errors = new Map(
          (output.Errors ?? []).map((item) => [item.Key, item.Code ?? "StorageError"]),
        );
        for (const key of batch) {
          if (confirmed.has(key) && !errors.has(key)) result.deleted.push(key);
          else result.errors.push({ key, code: errors.get(key) ?? "UnconfirmedDeletion" });
        }
      }
    } catch {
      result.errors.push(...batch.map((key) => ({ key, code: "UnconfirmedDeletion" })));
    }
  }
  return result;
}
