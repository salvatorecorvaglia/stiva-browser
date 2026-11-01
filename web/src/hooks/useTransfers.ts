import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ApiError, api, bucketPath, type Metadata, type Signed, uploadFile } from "../api";
export interface UploadTarget {
  serverId: string;
  bucket: string;
  prefix: string;
}
export interface TransferHandle {
  startUpload: (files: File[]) => Promise<void>;
}
type Transfer = {
  id: string;
  name: string;
  progress: number;
  status: "queued" | "uploading" | "done" | "error" | "canceled";
  message?: string;
  file?: File;
  serverId: string;
  serverName: string;
  contextKey: string;
  bucket: string;
  prefix: string;
};

export function useTransfers(props: {
  ref: Ref<TransferHandle>;
  target: UploadTarget;
  serverName: string;
  proxy: boolean;
  contextKey: string;
  notify: (text: string, error?: boolean) => void;
  onComplete: (target: UploadTarget) => void;
}) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  const queue = useRef<(() => Promise<void>)[]>([]);
  const active = useRef(0);
  function pump() {
    while (active.current < 4 && queue.current.length) {
      const run = queue.current.shift();
      if (!run) break;
      active.current++;
      void run().finally(() => {
        active.current--;
        pump();
      });
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: only server configuration changes cancel transfers.
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
      controllers.current.forEach((controller) => {
        controller.abort();
      });
    };
  }, [props.contextKey]);
  useImperativeHandle(props.ref, () => ({ startUpload }));
  async function startUpload(
    files: File[],
    throughBackend = props.proxy,
    target: UploadTarget & { serverName?: string } = props.target,
    retryId?: string,
  ) {
    if (!target.serverId || !target.bucket) return;
    const version = generation.current;
    for (const file of files) {
      const key = target.prefix + file.name;
      if (new TextEncoder().encode(key).length > 1024) {
        props.notify(`${file.name}: object key exceeds 1024 bytes`, true);
        continue;
      }
      const id = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      setTransfers((current) => [
        ...current
          .filter((item) => item.id !== retryId)
          .filter((item) => ["uploading", "queued"].includes(item.status))
          .concat(
            current
              .filter(
                (item) => item.id !== retryId && !["uploading", "queued"].includes(item.status),
              )
              .slice(-49),
          ),
        {
          id,
          name: file.name,
          contextKey: props.contextKey,
          file,
          serverId: target.serverId,
          serverName: target.serverName ?? props.serverName,
          bucket: target.bucket,
          prefix: target.prefix,
          progress: 0,
          status: "queued",
        },
      ]);
      const patch = (change: Partial<Transfer>) =>
        setTransfers((current) =>
          current.map((item) => (item.id === id ? { ...item, ...change } : item)),
        );
      controller.signal.addEventListener(
        "abort",
        () => {
          patch({ status: "canceled", message: "Upload canceled", file: undefined });
        },
        { once: true },
      );
      queue.current.push(async () => {
        try {
          if (version !== generation.current || controller.signal.aborted) {
            controller.abort();
            throw new DOMException("Upload canceled", "AbortError");
          }
          patch({ status: "uploading" });
          try {
            await api<Metadata>(
              `${bucketPath(target.bucket)}/objects/metadata?${new URLSearchParams({ key })}`,
              {
                signal: controller.signal,
                headers: {
                  "x-s3-server-revision": props.contextKey.slice(target.serverId.length + 1),
                },
              },
              target.serverId,
            );
            if (controller.signal.aborted) throw new DOMException("Upload canceled", "AbortError");
            if (!window.confirm(`Replace existing object “${file.name}”?`)) {
              controller.abort();
              throw new DOMException("Upload canceled", "AbortError");
            }
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          let url: string;
          let headers: Record<string, string>;
          if (throughBackend) {
            url = `/api/stream/upload?${new URLSearchParams({ bucket: target.bucket, key })}`;
            headers = {
              "x-s3-server-id": target.serverId,
              "x-s3-server-revision": props.contextKey.slice(target.serverId.length + 1),
              "Content-Type": file.type || "application/octet-stream",
            };
          } else {
            const result = await api<Signed>(
              "/api/presigned-url/upload",
              {
                method: "POST",
                headers: {
                  "x-s3-server-revision": props.contextKey.slice(target.serverId.length + 1),
                },
                signal: controller.signal,
                body: JSON.stringify({
                  bucket: target.bucket,
                  key,
                  contentType: file.type || "application/octet-stream",
                }),
              },
              target.serverId,
            );
            url = result.url;
            headers = result.required_headers;
          }
          await uploadFile(url, file, headers, controller.signal, (progress) =>
            patch({ progress }),
          );
          patch({ progress: 100, status: "done", file: undefined });
          props.onComplete(target);
        } catch (err) {
          patch({
            status: controller.signal.aborted ? "canceled" : "error",
            message:
              err instanceof ApiError && err.status === 403
                ? "Could not verify or write the destination. Check object read/write and bucket listing permissions before retrying."
                : (err as Error).message,
            ...(controller.signal.aborted ? { file: undefined } : {}),
          });
        } finally {
          controllers.current.delete(id);
        }
      });
    }
    pump();
  }
  return { transfers, setTransfers, controllers, startUpload };
}
