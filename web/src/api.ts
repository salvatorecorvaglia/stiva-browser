import type { DeletionResult } from "../../shared/contracts";

export type {
  Bucket,
  DeletionResult,
  Listing,
  Metadata,
  ObjectVersion,
  S3Object,
  Server,
  Signed,
  VersionListing,
} from "../../shared/contracts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  url: string,
  options: RequestInit = {},
  serverId?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (serverId) headers.set("x-s3-server-id", serverId);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.error?.code ?? "REQUEST_ERROR",
      body.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const bucketPath = (bucket: string) => `/api/buckets/${encodeURIComponent(bucket)}`;
export const streamUrl = (
  serverId: string,
  bucket: string,
  key: string,
  preview = false,
  versionId?: string,
) =>
  `/api/stream/download?${new URLSearchParams({ serverId, bucket, key, ...(preview ? { preview: "true" } : {}), ...(versionId ? { versionId } : {}) })}`;
export const bytes = (size: number) => {
  if (!size) return "0 B";
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
};
export const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

export function uploadFile(
  url: string,
  file: File,
  headers: Record<string, string>,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else
        reject(
          new Error(
            `Upload failed (${xhr.status}). Check S3 permissions and CORS, or retry through the backend.`,
          ),
        );
    };
    xhr.onerror = () => {
      finish();
      reject(
        new Error(
          "Upload could not reach S3. Check CORS and endpoint reachability, or retry through the backend.",
        ),
      );
    };
    xhr.onabort = () => {
      finish();
      reject(new DOMException("Upload canceled", "AbortError"));
    };
    if (signal.aborted) {
      finish();
      reject(new DOMException("Upload canceled", "AbortError"));
      return;
    }
    xhr.send(file);
  });
}

/** Split by wire bytes as well as count; escaped Unicode/control keys can grow in JSON. */
export function deletionBatches(keys: string[]) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = new TextEncoder().encode('{"keys":[]}').length;
  for (const key of new Set(keys)) {
    const length = new TextEncoder().encode(JSON.stringify(key)).length + (batch.length ? 1 : 0);
    if (batch.length && (batch.length >= 1000 || size + length > 60 * 1024)) {
      batches.push(batch);
      batch = [];
      size = 11;
    }
    batch.push(key);
    size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function deleteObjects(
  serverId: string,
  bucket: string,
  keys: string[],
): Promise<DeletionResult> {
  const result: DeletionResult = { deleted: [], errors: [] };
  for (const batch of deletionBatches(keys)) {
    try {
      const output = await api<DeletionResult>(
        `${bucketPath(bucket)}/objects`,
        {
          method: "DELETE",
          body: JSON.stringify({ keys: batch }),
        },
        serverId,
      );
      result.deleted.push(...output.deleted);
      result.errors.push(...output.errors);
    } catch {
      result.errors.push(...batch.map((key) => ({ key, code: "UnconfirmedDeletion" })));
    }
  }
  return result;
}
