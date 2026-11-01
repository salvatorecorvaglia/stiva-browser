import {
  ArrowDownToLine,
  History,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  bucketPath,
  bytes,
  date,
  type ObjectVersion,
  streamUrl,
  type VersionListing,
} from "./api";
import { Dialog } from "./Dialog";

export function VersionsModal({
  serverId,
  bucket,
  prefix,
  objectKey,
  onClose,
  onChange,
}: {
  serverId: string;
  bucket: string;
  prefix: string;
  objectKey?: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const [keyInput, setKeyInput] = useState(objectKey ?? "");
  const [exactKey, setExactKey] = useState(objectKey ?? "");
  const [versions, setVersions] = useState<ObjectVersion[]>([]);
  const [next, setNext] = useState<{ key: string; version?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [action, setAction] = useState<{
    type: "delete" | "restore";
    version: ObjectVersion;
  } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const read = useRef<AbortController | null>(null);
  const load = useCallback(
    async (marker?: { key: string; version?: string }) => {
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      setLoading(true);
      setError("");
      if (!marker) {
        setVersions([]);
        setNext(null);
      }
      const query = new URLSearchParams(exactKey ? { key: exactKey } : { prefix });
      if (marker) {
        query.set("keyMarker", marker.key);
        if (marker.version) query.set("versionIdMarker", marker.version);
      }
      try {
        const result = await api<VersionListing>(
          `${bucketPath(bucket)}/versions?${query}`,
          { signal: controller.signal },
          serverId,
        );
        if (controller.signal.aborted) return;
        setVersions((current) =>
          [
            ...new Map(
              [...(marker ? current : []), ...result.versions].map((version) => [
                JSON.stringify([version.key, version.version_id]),
                version,
              ]),
            ).values(),
          ].sort(
            (a, b) =>
              a.key.localeCompare(b.key) ||
              Number(b.is_latest) - Number(a.is_latest) ||
              (b.last_modified ? new Date(b.last_modified).getTime() : 0) -
                (a.last_modified ? new Date(a.last_modified).getTime() : 0),
          ),
        );
        setNext(
          result.next_key_marker
            ? {
                key: result.next_key_marker,
                version: result.next_version_id_marker ?? undefined,
              }
            : null,
        );
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [serverId, bucket, prefix, exactKey],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision reloads history after writes.
  useEffect(() => {
    setAction(null);
    setConfirmation("");
    void load();
    return () => read.current?.abort();
  }, [load, revision]);
  async function applyAction() {
    if (!action || confirmation !== action.version.key) return;
    setWorking(true);
    setError("");
    setNotice("");
    const { version, type } = action;
    try {
      await api(
        `${bucketPath(bucket)}/versions${type === "restore" ? "/restore" : ""}`,
        {
          method: type === "restore" ? "POST" : "DELETE",
          body: JSON.stringify({
            key: version.key,
            versionId: version.version_id,
            confirmation,
          }),
        },
        serverId,
      );
      setNotice(
        type === "restore"
          ? "Restored as a new current version. Previous versions were retained."
          : "Version permanently deleted.",
      );
      setAction(null);
      setConfirmation("");
      setRevision((value) => value + 1);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <Dialog
      wide
      title="Object versions"
      subtitle={`${bucket} / ${exactKey || prefix || "all objects"}`}
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <div className="versions-body">
        <form
          className="version-search"
          onSubmit={(event) => {
            event.preventDefault();
            setExactKey(keyInput);
            setRevision((value) => value + 1);
          }}
        >
          <label>
            Exact object key
            <input
              value={keyInput}
              placeholder="Leave blank to browse this folder’s version history"
              disabled={working}
              onChange={(event) => setKeyInput(event.target.value)}
            />
          </label>
          <button type="submit" className="button secondary" disabled={working}>
            <History size={14} />
            View history
          </button>
        </form>
        <p className="muted version-explanation">
          Includes delete markers and objects hidden from the regular listing. Restore creates a new
          current version; deleting a version or marker is permanent. Your S3 account needs
          version-listing permissions.
        </p>
        {notice && (
          <p className="form-message success" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="form-message error" role="alert">
            <Info size={16} />
            {error}
          </p>
        )}
        {action && (
          <form
            className="version-confirm simple-form"
            onSubmit={(event) => {
              event.preventDefault();
              void applyAction();
            }}
          >
            <h3>
              {action.type === "delete"
                ? "Permanently delete this version?"
                : "Restore this version as current?"}
            </h3>
            <p>
              <strong>{action.version.key}</strong>
              <br />
              <code>{action.version.version_id}</code>
              {action.version.is_delete_marker && (
                <>
                  <br />
                  Removing a delete marker may make an earlier version visible again.
                </>
              )}
            </p>
            <label>
              Type the complete object key to confirm
              <input
                autoComplete="off"
                value={confirmation}
                disabled={working}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className="form-actions">
              <button
                className="button secondary"
                type="button"
                disabled={working}
                onClick={() => setAction(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`button ${action.type === "delete" ? "danger" : "primary"}`}
                disabled={working || confirmation !== action.version.key}
              >
                {working ? (
                  <LoaderCircle size={14} className="spin" />
                ) : action.type === "delete" ? (
                  <Trash2 size={14} />
                ) : (
                  <RotateCcw size={14} />
                )}{" "}
                {working
                  ? "Working…"
                  : action.type === "delete"
                    ? "Permanently delete version"
                    : "Restore version"}
              </button>
            </div>
          </form>
        )}
        <div className="table-scroll versions-table">
          <table>
            <thead>
              <tr>
                <th>Object / version</th>
                <th>Size</th>
                <th>Modified</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={JSON.stringify([version.key, version.version_id])}>
                  <td>
                    <strong>{version.key}</strong>
                    <code>{version.version_id}</code>
                    <div className="version-badges">
                      {version.is_latest && <span>Current</span>}
                      {version.is_delete_marker && (
                        <span className="marker-badge">Delete marker</span>
                      )}
                    </div>
                  </td>
                  <td>{version.is_delete_marker ? "—" : bytes(version.size)}</td>
                  <td>{date(version.last_modified)}</td>
                  <td>
                    <div className="row-actions">
                      {!version.is_delete_marker && (
                        <>
                          <a
                            className="icon-button"
                            title={`Download version ${version.version_id}`}
                            href={streamUrl(
                              serverId,
                              bucket,
                              version.key,
                              false,
                              version.version_id,
                            )}
                          >
                            <ArrowDownToLine size={15} />
                          </a>
                          <button
                            type="button"
                            className="icon-button"
                            title={`Restore version ${version.version_id}`}
                            disabled={working}
                            onClick={() => {
                              setAction({ type: "restore", version });
                              setConfirmation("");
                              setError("");
                            }}
                          >
                            <RotateCcw size={15} />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="icon-button delete-action"
                        title={`Permanently delete version ${version.version_id}`}
                        disabled={working}
                        onClick={() => {
                          setAction({ type: "delete", version });
                          setConfirmation("");
                          setError("");
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && (
          <div className="object-tool-status">
            <LoaderCircle size={20} className="spin" />
            Loading version history…
          </div>
        )}
        {!loading && !versions.length && !error && (
          <p className="object-tool-status">No versions found for this location.</p>
        )}
        <div className="version-pagination">
          <span>{versions.length} versions loaded</span>
          <button
            type="button"
            className="button secondary"
            disabled={working || loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          {next && (
            <button
              type="button"
              className="button secondary"
              disabled={working || loading}
              onClick={() => void load(next)}
            >
              Load more versions
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
