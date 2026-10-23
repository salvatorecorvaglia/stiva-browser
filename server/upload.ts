import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { HttpError } from "./errors.js";

const MiB = 1024 ** 2;
export function uploadPartSize(length?: number) {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
    throw new HttpError(400, "Invalid upload Content-Length");
  const size = Math.max(8 * MiB, Math.ceil((length ?? 0) / 10000 / MiB) * MiB);
  if (size > 16 * MiB) throw new HttpError(413, "Upload exceeds the backend limit of 156.25 GiB");
  return size;
}

async function* chunks(body: Readable, size: number, signal: AbortSignal) {
  let buffer = Buffer.allocUnsafe(size);
  let used = 0;
  for await (const value of body) {
    signal.throwIfAborted();
    const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (let offset = 0; offset < chunk.length; ) {
      const count = Math.min(size - used, chunk.length - offset);
      chunk.copy(buffer, used, offset, offset + count);
      used += count;
      offset += count;
      if (used === size) {
        yield buffer;
        buffer = Buffer.allocUnsafe(size);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}

/** Own all in-flight work, including abort cleanup, before the caller destroys the client. */
export async function uploadObject(
  client: S3Client,
  input: { bucket: string; key: string; contentType: string; length?: number },
  body: Readable,
  signal: AbortSignal,
) {
  const partSize = uploadPartSize(input.length);
  const params = { Bucket: input.bucket, Key: input.key, ContentType: input.contentType };
  const controller = new AbortController();
  const stopped = AbortSignal.any([signal, controller.signal]);
  const destroyBody = () => body.destroy(new Error("Upload interrupted"));
  stopped.addEventListener("abort", destroyBody, { once: true });
  let uploadId: string | undefined;
  let failure: unknown;
  let failed = false;
  const tasks = new Set<Promise<void>>();
  const parts: { PartNumber: number; ETag: string }[] = [];
  let count = 0;
  let length = 0;
  const sendPart = (data: Buffer) => {
    const number = ++count;
    if (number > 10000)
      throw new HttpError(
        413,
        "Unknown-length upload exceeds 78.125 GiB; supply Content-Length for larger files",
      );
    const task = (async () => {
      try {
        const result = await client.send(
          new UploadPartCommand({
            ...params,
            UploadId: uploadId,
            PartNumber: number,
            Body: data,
            ContentLength: data.length,
          }),
          { abortSignal: stopped },
        );
        if (!result.ETag) throw new HttpError(502, "Storage omitted the uploaded-part checksum");
        parts.push({ PartNumber: number, ETag: result.ETag });
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
        controller.abort();
      }
    })();
    tasks.add(task);
    void task.then(() => tasks.delete(task));
  };
  try {
    stopped.throwIfAborted();
    // Look ahead once so small and empty files use PutObject, preserving provider compatibility.
    const iterator = chunks(body, partSize, stopped)[Symbol.asyncIterator]();
    {
      const first = await iterator.next();
      const second = first.done ? first : await iterator.next();
      if (second.done) {
        const data = first.done ? Buffer.alloc(0) : first.value;
        if (input.length !== undefined && data.length !== input.length)
          throw new HttpError(400, "Upload length does not match Content-Length");
        await client.send(
          new PutObjectCommand({ ...params, Body: data, ContentLength: data.length }),
          { abortSignal: stopped },
        );
        return;
      }
      const created = await client.send(new CreateMultipartUploadCommand(params), {
        abortSignal: stopped,
      });
      uploadId = created.UploadId;
      if (!uploadId) throw new HttpError(502, "Storage omitted the multipart upload identifier");
      for (const data of [first.value as Buffer, second.value]) {
        length += data.length;
        sendPart(data);
      }
    }
    while (true) {
      if (tasks.size >= 2) await Promise.race(tasks);
      if (failed) throw failure;
      stopped.throwIfAborted();
      const next = await iterator.next();
      if (next.done) break;
      length += next.value.length;
      sendPart(next.value);
    }
    await Promise.all(tasks);
    if (failed) throw failure;
    stopped.throwIfAborted();
    if (input.length !== undefined && length !== input.length)
      throw new HttpError(400, "Upload length does not match Content-Length");
    await client.send(
      new CompleteMultipartUploadCommand({
        ...params,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
      }),
      { abortSignal: stopped },
    );
  } catch (error) {
    controller.abort();
    await Promise.all(tasks);
    if (uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ ...params, UploadId: uploadId }), {
          abortSignal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new HttpError(
          502,
          "Upload failed and multipart cleanup could not be confirmed. Inspect incomplete uploads on the S3 server.",
          "MULTIPART_CLEANUP_FAILED",
        );
      }
    }
    throw failed ? failure : error;
  } finally {
    stopped.removeEventListener("abort", destroyBody);
  }
}
