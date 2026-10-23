import {
  ArrowDownToLine,
  Check,
  Copy,
  Eye,
  File,
  FolderPlus,
  History,
  Info,
  Trash2,
} from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import {
  api,
  bucketPath,
  bytes,
  date,
  type Metadata,
  type S3Object,
  type Signed,
  streamUrl,
} from "../api";
import { Dialog } from "../Dialog";
import { Empty, Loading } from "./Primitives";
export function LinkModal({ signed, onClose }: { signed: Signed; onClose: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      title="Presigned download URL"
      subtitle="Anyone with this link can download the object until it expires."
      onClose={onClose}
    >
      <div className="simple-form">
        <label>
          Download URL
          <textarea
            ref={field}
            className="link-field"
            readOnly
            value={signed.url}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <p className="muted">Expires {date(signed.expires_at)}</p>
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            onClick={async () => {
              field.current?.focus();
              field.current?.select();
              try {
                await navigator.clipboard.writeText(signed.url);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy URL"}
          </button>
          <a className="button primary" href={signed.url} target="_blank" rel="noopener noreferrer">
            <ArrowDownToLine size={15} />
            Open download
          </a>
        </div>
      </div>
    </Dialog>
  );
}

export function FolderModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  return (
    <Dialog
      title="New folder"
      subtitle="Create a folder in the current location."
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <form
        className="simple-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || name.includes("/")) {
            setError("Enter a folder name without slashes.");
            return;
          }
          setWorking(true);
          try {
            await onCreate(name.trim());
          } catch (err) {
            setError((err as Error).message);
            setWorking(false);
          }
        }}
      >
        <label>
          Folder name
          <input
            autoFocus
            required
            value={name}
            placeholder="e.g. project-assets"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={working}>
            <FolderPlus size={15} />
            {working ? "Creating…" : "Create folder"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function DeleteModal({
  keys,
  onClose,
  onDelete,
}: {
  keys: string[];
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title={`Delete ${keys.length === 1 ? "object" : `${keys.length} objects`}?`}
      subtitle="This removes the selected objects from your S3 bucket."
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <div className="simple-form">
        <div className="delete-list">
          {keys.map((key) => (
            <div key={key}>
              <File size={15} />
              <span>{key}</span>
            </div>
          ))}
        </div>
        <p className="muted">
          On versioned buckets, S3 versioning rules apply. This action deletes only the selected
          keys.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try {
                await onDelete();
              } catch (err) {
                setError((err as Error).message);
                setWorking(false);
              }
            }}
          >
            <Trash2 size={15} />
            {working ? "Deleting…" : "Delete objects"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
export function InspectModal({
  serverId,
  bucket,
  object,
  preview,
  onClose,
  onCopy,
  onVersions,
}: {
  serverId: string;
  bucket: string;
  object: S3Object;
  preview: boolean;
  onClose: () => void;
  onCopy: () => void;
  onVersions: () => void;
}) {
  const panelId = useId();
  const previewTab = useRef<HTMLButtonElement>(null);
  const detailsTab = useRef<HTMLButtonElement>(null);
  const tabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "preview"
        : event.key === "End"
          ? "details"
          : event.currentTarget === previewTab.current
            ? "details"
            : "preview";
    setTab(next);
    (next === "preview" ? previewTab : detailsTab).current?.focus();
  };
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(preview ? "preview" : "details");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Metadata>(
      `${bucketPath(bucket)}/objects/metadata?${new URLSearchParams({ key: object.key })}`,
      { signal: controller.signal },
      serverId,
    )
      .then((result) => {
        if (!controller.signal.aborted) setMetadata(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [serverId, bucket, object.key]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    if (tab !== "preview" || !metadata) return;
    const controller = new AbortController();
    let blobUrl = "";
    async function loadPreview() {
      if (!metadata) return;
      setPreviewLoading(true);
      setPreviewError("");
      const mime = metadata.content_type?.split(";")[0].toLowerCase() ?? "";
      try {
        if (!/^(image\/(png|jpeg|gif|webp|avif)|text\/(plain|csv)|application\/json)$/.test(mime))
          throw new Error(
            "Preview is unavailable for this file type. Download the object to open it.",
          );
        if (mime.startsWith("image/") && metadata.size > 1048576)
          throw new Error("This image is too large to preview. Download it to view the full file.");
        if (metadata.size === 0 && !mime.startsWith("image/")) {
          setText("");
          return;
        }
        const response = await fetch(streamUrl(serverId, bucket, object.key, true), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Could not load preview");
        if (mime.startsWith("image/")) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          blobUrl = URL.createObjectURL(blob);
          setImage(blobUrl);
        } else {
          const contents = await response.text();
          if (!controller.signal.aborted) setText(contents);
        }
      } catch (err) {
        if (!controller.signal.aborted) setPreviewError((err as Error).message);
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }
    void loadPreview();
    return () => {
      controller.abort();
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        setImage("");
      }
    };
  }, [serverId, bucket, object.key, tab, metadata]);
  return (
    <Dialog
      wide
      title={object.key.split("/").pop() || object.key}
      subtitle={`${bucket} / ${object.key}`}
      onClose={onClose}
    >
      <div className="inspect-tabs" role="tablist" aria-label="Object information">
        <button
          type="button"
          ref={previewTab}
          role="tab"
          id={`${panelId}-preview`}
          aria-selected={tab === "preview"}
          aria-controls={panelId}
          tabIndex={tab === "preview" ? 0 : -1}
          onKeyDown={tabKey}
          className={tab === "preview" ? "active" : ""}
          onClick={() => setTab("preview")}
        >
          <Eye size={15} />
          Preview
        </button>
        <button
          type="button"
          ref={detailsTab}
          role="tab"
          id={`${panelId}-details`}
          aria-selected={tab === "details"}
          aria-controls={panelId}
          tabIndex={tab === "details" ? 0 : -1}
          onKeyDown={tabKey}
          className={tab === "details" ? "active" : ""}
          onClick={() => setTab("details")}
        >
          <Info size={15} />
          Metadata
        </button>
      </div>
      <div
        className="inspect-content"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabpanels must be focusable to read and scroll static previews.
        tabIndex={0}
      >
        {loading || (tab === "preview" && previewLoading) ? (
          <Loading label="Loading object…" />
        ) : tab === "preview" ? (
          error || previewError ? (
            <Empty
              icon={<File size={30} />}
              title="Preview unavailable"
              text={error || previewError}
            />
          ) : image ? (
            <img className="image-preview" alt={object.key} src={image} />
          ) : (
            <>
              <pre className="text-preview">{text}</pre>
              {metadata && metadata.size > 1048576 && (
                <p className="muted">Showing the first 1 MB.</p>
              )}
            </>
          )
        ) : metadata ? (
          <dl className="metadata">
            {Object.entries({
              Key: object.key,
              Size: bytes(metadata.size),
              "Content type": metadata.content_type,
              Modified: date(metadata.last_modified),
              ETag: metadata.etag,
              "Storage class": metadata.storage_class,
              ...metadata.metadata,
            }).map(([key, value]) => (
              <React.Fragment key={key}>
                <dt>{key}</dt>
                <dd>{value || "—"}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : (
          <p className="error-text">{error}</p>
        )}
      </div>
      <div className="inspect-footer">
        <button type="button" className="button secondary" onClick={onVersions}>
          <History size={15} />
          Versions
        </button>
        <button type="button" className="button secondary" onClick={onCopy}>
          <Copy size={15} />
          Copy presigned URL
        </button>
        <a className="button primary" href={streamUrl(serverId, bucket, object.key)}>
          <ArrowDownToLine size={15} />
          Download
        </a>
      </div>
    </Dialog>
  );
}
