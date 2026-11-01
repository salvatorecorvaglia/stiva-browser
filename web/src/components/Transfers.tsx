import { Check, File, UploadCloud, X } from "lucide-react";
import type { Ref } from "react";
import { type TransferHandle, type UploadTarget, useTransfers } from "../hooks/useTransfers";

export type { TransferHandle, UploadTarget } from "../hooks/useTransfers";
export function Transfers(props: {
  ref: Ref<TransferHandle>;
  target: UploadTarget;
  serverName: string;
  proxy: boolean;
  contextKey: string;
  notify: (text: string, error?: boolean) => void;
  onComplete: (target: UploadTarget) => void;
}) {
  const { transfers, setTransfers, controllers, startUpload } = useTransfers(props);
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
                setTransfers((current) =>
                  current.filter((item) => ["uploading", "queued"].includes(item.status)),
                )
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
                {["uploading", "queued"].includes(item.status) ? (
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
                {item.status === "queued"
                  ? "Queued"
                  : item.status === "uploading"
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
                  disabled={item.contextKey !== props.contextKey}
                  onClick={() => {
                    if (item.file) void startUpload([item.file], true, item, item.id);
                  }}
                >
                  {item.contextKey === props.contextKey
                    ? "Retry through backend"
                    : "Configuration changed; select the file again"}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
