export interface Server {
  id: string;
  name: string;
  endpoint_url: string;
  region: string;
  access_key: string;
  has_secret_key: boolean;
  force_path_style: boolean;
  created_at: string;
  updated_at: string;
}
export interface Bucket {
  name: string;
  created_at?: string;
}
export interface S3Object {
  key: string;
  size: number;
  last_modified?: string;
  etag?: string;
}
export interface Listing {
  objects: S3Object[];
  prefixes: string[];
  next_token: string | null;
}
export interface Metadata {
  size: number;
  content_type: string;
  last_modified?: string;
  etag?: string;
  metadata: Record<string, string>;
  storage_class: string;
}
export interface Signed {
  url: string;
  expires_at: string;
  required_headers: Record<string, string>;
}
export interface ObjectVersion {
  key: string;
  version_id: string;
  is_latest: boolean;
  is_delete_marker: boolean;
  size: number;
  last_modified?: string;
  etag?: string;
}
export interface VersionListing {
  versions: ObjectVersion[];
  next_key_marker: string | null;
  next_version_id_marker: string | null;
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
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
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
