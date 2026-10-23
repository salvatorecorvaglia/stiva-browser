import { z } from "zod";

export const keySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => new TextEncoder().encode(key).length <= 1024, "Key exceeds 1024 bytes");
export const folderSchema = keySchema.refine(
  (key) => key.endsWith("/"),
  "A nonempty folder prefix ending in / is required",
);
export const versionIdSchema = z.string().min(1).max(2048);
export interface DeletionResult {
  deleted: string[];
  errors: { key: string; code: string }[];
}

export interface Server {
  id: string;
  revision: string;
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

export const serverInput = z.object({
  name: z.string().trim().min(1).max(120),
  endpoint_url: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Use an HTTP(S) endpoint without credentials, query parameters, or fragments"),
  region: z.string().trim().min(1).max(100).default("us-east-1"),
  access_key: z.string().min(1).max(1024).optional(),
  secret_key: z.string().min(1).max(4096).optional(),
  force_path_style: z.boolean().default(true),
});
export type ServerInput = z.infer<typeof serverInput>;
