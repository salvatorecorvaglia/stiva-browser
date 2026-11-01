import { LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, bucketPath, bytes, date } from "../api";
import { Dialog } from "../Dialog";

interface FolderPreview {
  preview_token: string;
  prefix: string;
  count: number;
  size: number;
  sample: string[];
  expires_at: string;
}
export function FolderDeleteModal({
  serverId,
  bucket,
  prefix,
  onClose,
  onComplete,
}: {
  serverId: string;
  bucket: string;
  prefix: string;
  onClose: () => void;
  onComplete: (deleted: number, errors: string[]) => void;
}) {
  const [preview, setPreview] = useState<FolderPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the deletion snapshot.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPreview(null);
    setError("");
    setConfirmation("");
    api<FolderPreview>(
      `${bucketPath(bucket)}/folders/delete-preview?${new URLSearchParams({ prefix })}`,
      { signal: controller.signal },
      serverId,
    )
      .then(setPreview)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [serverId, bucket, prefix, revision]);
  return (
    <Dialog
      title="Delete folder and contents?"
      subtitle={`${bucket} / ${prefix}`}
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <form
        className="simple-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!preview || confirmation !== prefix) return;
          setWorking(true);
          setError("");
          try {
            const result = await api<{
              deleted: string[];
              errors: { key: string; code: string }[];
            }>(
              `${bucketPath(bucket)}/folders`,
              {
                method: "DELETE",
                body: JSON.stringify({
                  prefix,
                  confirmation,
                  preview_token: preview.preview_token,
                }),
              },
              serverId,
            );
            onComplete(
              result.deleted.length,
              result.errors.map((item) => `${item.key} (${item.code})`),
            );
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setWorking(false);
          }
        }}
      >
        {loading ? (
          <div className="object-tool-status">
            <LoaderCircle size={20} className="spin" />
            Inspecting all objects in this folder…
          </div>
        ) : (
          preview && (
            <>
              <p className="deletion-summary">
                <strong>{preview.count.toLocaleString()} objects</strong> · {bytes(preview.size)}
              </p>
              <div className="delete-list">
                {preview.sample.map((key) => (
                  <div key={key}>
                    <span>{key}</span>
                  </div>
                ))}
              </div>
              {preview.count > preview.sample.length && (
                <p className="muted">Showing the first {preview.sample.length} keys.</p>
              )}
              <p className="muted">
                Deletes only keys in this preview, including nested folders. New keys added
                afterward are excluded. Existing versions are retained according to S3 versioning
                rules. Preview expires {date(preview.expires_at)}.
              </p>
              <label>
                Type the complete folder prefix to confirm
                <input
                  autoComplete="off"
                  value={confirmation}
                  placeholder={prefix}
                  disabled={working}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
            </>
          )
        )}
        {error && (
          <p className="form-message error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="button secondary"
            type="button"
            disabled={working || loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={14} />
            Refresh preview
          </button>
          <button
            type="submit"
            className="button danger"
            disabled={working || loading || !preview?.count || confirmation !== prefix}
          >
            <Trash2 size={15} />
            {working ? "Deleting…" : "Delete folder contents"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
