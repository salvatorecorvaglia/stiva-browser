import type { S3Object, Signed } from "./api";
export type WorkspaceModal =
  | { type: "folder" }
  | { type: "folder-delete"; prefix: string }
  | { type: "versions"; key?: string }
  | { type: "delete"; keys: string[] }
  | { type: "inspect"; object: S3Object; preview: boolean }
  | { type: "link"; signed: Signed }
  | null;
