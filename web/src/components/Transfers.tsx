import { Check, File, UploadCloud, X } from "lucide-react";
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
  status: "uploading" | "done" | "error" | "canceled";
  message?: string;
  file?: File;
  serverId: string;
  serverName: string;
  bucket: string;
  prefix: string;
};

export function Transfers(props: {
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
  ) {
    if (!target.serverId || !target.bucket) return;
    if (controllers.current.size >= 4) {
      props.notify("Four uploads are already active. Wait before adding more.", true);
      return;
    }
    const version = generation.current;
    for (const file of files) {
      if (version !== generation.current) break;
      const key = target.prefix + file.name;
      if (new TextEncoder().encode(key).length > 1024) {
        props.notify(`${file.name}: object key exceeds 1024 bytes`, true);
        continue;
      }
      try {
        await api<Metadata>(
          `${bucketPath(target.bucket)}/objects/metadata?${new URLSearchParams({ key })}`,
          {},
          target.serverId,
        );
        if (version !== generation.current) break;
        if (!window.confirm(`Replace existing object “${file.name}”?`)) continue;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) {
          props.notify((err as Error).message, true);
          continue;
        }
      }
      if (version !== generation.current) break;
      if (controllers.current.size >= 4) {
        props.notify("Four uploads are already active. Wait before adding more.", true);
        break;
      }
      const id = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      setTransfers((current) => [
        ...current
          .filter((item) => item.status === "uploading")
          .concat(current.filter((item) => item.status !== "uploading").slice(-49)),
        {
          id,
          name: file.name,
          file,
          serverId: target.serverId,
          serverName: target.serverName ?? props.serverName,
          bucket: target.bucket,
          prefix: target.prefix,
          progress: 0,
          status: "uploading",
        },
      ]);
      const patch = (change: Partial<Transfer>) =>
        setTransfers((current) =>
          current.map((item) => (item.id === id ? { ...item, ...change } : item)),
        );
      try {
        let url: string;
        let headers: Record<string, string>;
        if (throughBackend) {
          url = `/api/stream/upload?${new URLSearchParams({ bucket: target.bucket, key })}`;
          headers = {
            "x-s3-server-id": target.serverId,
            "Content-Type": file.type || "application/octet-stream",
          };
        } else {
          const result = await api<Signed>(
            "/api/presigned-url/upload",
            {
              method: "POST",
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
        await uploadFile(url, file, headers, controller.signal, (progress) => patch({ progress }));
        patch({ progress: 100, status: "done", file: undefined });
        props.onComplete(target);
      } catch (err) {
        patch({
          status: controller.signal.aborted ? "canceled" : "error",
          message: (err as Error).message,
          ...(controller.signal.aborted ? { file: undefined } : {}),
        });
      } finally {
        controllers.current.delete(id);
      }
    }
  }
  return (
    <>
      {" "}
      {!!transfers.length && (
        <section className="transfers" aria-label="File transfers">
          <div className="transfers-heading">
            <strong>
              <UploadCloud size={16} />
              Transfers
            </strong>
            <button
              type="button"
              className="icon-button"
              title="Dismiss completed transfers"
              onClick={() =>
                setTransfers((current) => current.filter((item) => item.status === "uploading"))
              }
            >
              <X size={16} />
            </button>
          </div>
          {transfers.map((item) => (
            <div key={item.id} className="transfer-item">
              <div>
                <File size={16} />
                <strong>{item.name}</strong>
                {item.status === "uploading" ? (
                  <button
                    type="button"
                    className="icon-button"
                    title="Cancel upload"
                    onClick={() => controllers.current.get(item.id)?.abort()}
                  >
                    <X size={14} />
                  </button>
                ) : item.status === "done" ? (
                  <Check size={16} className="text-emerald-600" />
                ) : (
                  <span className="error-text">{item.status}</span>
                )}
              </div>
              <small className="transfer-destination">
                {item.serverName} / {item.bucket} / {item.prefix}
              </small>
              <small>
                {item.status === "uploading"
                  ? `${item.progress}% · ${item.progress === 100 ? "Finishing…" : "Uploading"}`
                  : (item.message ?? (item.status === "done" ? "Upload complete" : "Canceled"))}
              </small>
              <div
                className="progress-track"
                role="progressbar"
                aria-label={`Upload ${item.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.progress}
              >
                <i style={{ width: `${item.progress}%` }} />
              </div>
              {item.status === "error" && (
                <button
                  type="button"
                  className="text-button"
                  disabled={item.serverId !== props.target.serverId}
                  onClick={() => {
                    setTransfers((current) => current.filter((t) => t.id !== item.id));
                    if (item.file) void startUpload([item.file], true, item);
                  }}
                >
                  {item.serverId === props.target.serverId
                    ? "Retry through backend"
                    : "Select original server to retry"}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
