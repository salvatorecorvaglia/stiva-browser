import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  Database,
  File,
  Folder,
  FolderPlus,
  HardDrive,
  History,
  Info,
  Plus,
  RefreshCw,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  bucketPath,
  bytes,
  date,
  deleteObjects,
  type S3Object,
  type Server,
  type Signed,
  streamUrl,
} from "./api";
import "./styles.css";
import { DeleteModal, FolderModal, InspectModal, LinkModal } from "./components/ObjectModals";
import { ObjectRows } from "./components/ObjectRows";
import { Empty, Loading, Stat } from "./components/Primitives";
import { ServerManager } from "./components/ServerManager";
import { type TransferHandle, Transfers } from "./components/Transfers";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useFileDrop } from "./hooks/useFileDrop";
import { useBuckets, useObjects } from "./hooks/useStorage";
import { FolderDeleteModal, VersionsModal } from "./ObjectTools";
import type { WorkspaceModal } from "./types";

type Notice = { text: string; error?: boolean };
type Modal = WorkspaceModal;

function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [serverId, setServerId] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [tokens, setTokens] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [bucketRevision, setBucketRevision] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [manager, setManager] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [filter, setFilter] = useState("");
  const [bucketFilter, setBucketFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Modal>(null);
  const [proxy, setProxy] = useState(false);

  const transferRef = useRef<TransferHandle>(null);
  const dragging = useFileDrop(Boolean(bucket) && !manager && !modal, (files) => {
    void transferRef.current?.startUpload(files);
  });
  const contextVersion = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const server = servers.find((item) => item.id === serverId);
  const serverContext = `${serverId}:${server?.revision ?? ""}`;
  const {
    buckets,
    busy: bucketBusy,
    connected,
    error: bucketError,
  } = useBuckets(serverId, server?.revision ?? "", bucketRevision);
  const { listing, busy, error } = useObjects(serverId, bucket, prefix, tokens[page], revision);
  const workspace = useRef({ serverId, bucket, prefix });
  workspace.current = { serverId, bucket, prefix };
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 680px)").matches);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 680px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  const loadServers = useCallback(async () => {
    const result = await api<Server[]>("/api/servers");
    setServers(result);
    setServerId((current) =>
      result.some((item) => item.id === current) ? current : (result[0]?.id ?? ""),
    );
  }, []);
  useEffect(() => {
    void loadServers().catch((err) => notify(err.message, true));
  }, [loadServers, notify]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), notice.error ? 10000 : 4500);
    return () => clearTimeout(timeout);
  }, [notice]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: configuration identity invalidates the workspace.
  useEffect(() => {
    contextVersion.current++;
    setBucket("");
    setPrefix("");
    setTokens([undefined]);
    setPage(0);
    setModal(null);
  }, [serverContext]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: page changes and refresh clear the previous selection.
  useEffect(() => {
    setSelected(new Set());
  }, [serverId, bucket, prefix, page, revision]);

  function navigate(nextBucket: string, nextPrefix = "") {
    contextVersion.current++;
    setBucket(nextBucket);
    setPrefix(nextPrefix);
    setPage(0);
    setTokens([undefined]);
    setFilter("");
    setSelected(new Set());
    setSidebar(false);
    if (mobile) sidebarToggle.current?.focus();
    setModal(null);
  }
  function switchServer(id: string) {
    contextVersion.current++;
    setServerId(id);
    navigate("");
  }
  function closeModal() {
    contextVersion.current++;
    setModal(null);
  }
  function refresh() {
    setPage(0);
    setTokens([undefined]);
    setRevision((value) => value + 1);
  }
  async function signed(object: S3Object, download = false) {
    const version = contextVersion.current;
    const id = serverId;
    const currentBucket = bucket;
    try {
      if (download) {
        window.location.assign(streamUrl(id, currentBucket, object.key));
        return;
      }
      const result = await api<Signed>(
        "/api/presigned-url/download",
        {
          method: "POST",
          body: JSON.stringify({ bucket: currentBucket, key: object.key }),
        },
        id,
      );
      if (version !== contextVersion.current) return;
      setModal({ type: "link", signed: result });
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(result.url).then(
          () => notify("Download link copied. Expires in 15 minutes."),
          () => notify("Link ready. Copy it from the dialog."),
        );
      }
    } catch (err) {
      notify((err as Error).message, true);
    }
  }

  const folders = useMemo(
    () => listing.prefixes.filter((key) => key.toLowerCase().includes(filter.toLowerCase())).sort(),
    [listing.prefixes, filter],
  );
  const objects = useMemo(
    () =>
      listing.objects
        .filter((object) => object.key.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => a.key.localeCompare(b.key)),
    [listing.objects, filter],
  );
  const visibleKeys = objects.map((object) => object.key);
  const totalSize = listing.objects.reduce((sum, object) => sum + object.size, 0);
  const parts = prefix ? prefix.slice(0, -1).split("/") : [];

  return (
    <div className="app-shell">
      <WorkspaceHeader
        servers={servers}
        serverId={serverId}
        connected={connected}
        sidebar={sidebar}
        sidebarToggle={sidebarToggle}
        setSidebar={setSidebar}
        switchServer={switchServer}
        setManager={setManager}
      />

      <WorkspaceSidebar
        buckets={buckets}
        bucket={bucket}
        serverId={serverId}
        server={server}
        mobile={mobile}
        sidebar={sidebar}
        bucketBusy={bucketBusy}
        bucketFilter={bucketFilter}
        setBucketFilter={setBucketFilter}
        setBucketRevision={setBucketRevision}
        setManager={setManager}
        setSidebar={setSidebar}
        sidebarToggle={sidebarToggle}
        navigate={navigate}
      />

      <main className="main">
        {dragging && (
          <div className="drop-overlay" role="status">
            <UploadCloud size={48} />
            <h2>Drop files into {prefix || bucket}</h2>
            <p>Your files go directly into this folder.</p>
          </div>
        )}
        <div className="page-eyebrow">
          <span className="eyebrow-icon">
            <Cloud size={14} />
          </span>
          OBJECT STORAGE <ChevronRight size={12} />
          <span>{server?.name ?? "Get started"}</span>
        </div>
        <div className="page-heading">
          <div>
            <h1>
              {bucket || "Your storage workspace"}
              <span className="title-dot">.</span>
            </h1>
            <p>
              {bucket
                ? "Browse, organize, and move your objects. All in one place."
                : "All your S3 storage. One clear view."}
            </p>
          </div>
          <span className="workspace-badge">
            <span />
            S3 compatible
          </span>
        </div>

        {!serverId ? (
          <section className="welcome-panel">
            <div className="welcome-art">
              <Cloud size={54} />
              <span>
                <Plus size={18} />
              </span>
            </div>
            <span className="section-kicker">WELCOME TO STIVA</span>
            <h2>A home for all your storage.</h2>
            <p>
              Connect AWS S3, MinIO, or any S3-compatible server.
              <br />
              Browse your buckets and manage your files from one workspace.
            </p>
            <button type="button" className="button primary" onClick={() => setManager(true)}>
              <Plus size={16} />
              Connect your first server
            </button>
            <div className="welcome-features">
              <span>
                <ShieldCheck size={15} />
                Encrypted credentials
              </span>
              <span>
                <ServerIcon size={15} />
                Multiple servers
              </span>
              <span>
                <UploadCloud size={15} />
                Direct & proxy transfers
              </span>
            </div>
          </section>
        ) : !bucket ? (
          <>
            {bucketError && (
              <div className="error-panel">
                <Info size={18} />
                <div>
                  <strong>Couldn’t connect to this server</strong>
                  <p>{bucketError}</p>
                </div>
                <button type="button" className="button secondary" onClick={() => setManager(true)}>
                  Check configuration
                </button>
              </div>
            )}
            <div className="section-title">
              <h2>
                Buckets <span>{buckets.length}</span>
              </h2>
              <button
                type="button"
                className="button secondary"
                onClick={() => setBucketRevision((value) => value + 1)}
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            </div>
            {bucketBusy ? (
              <Loading label="Connecting to your storage…" />
            ) : (
              <div className="bucket-grid">
                {buckets.map((item) => (
                  <button
                    type="button"
                    className="bucket-card"
                    key={item.name}
                    onClick={() => navigate(item.name)}
                  >
                    <span className="bucket-card-icon">
                      <HardDrive size={24} />
                    </span>
                    <ChevronRight size={17} className="card-arrow" />
                    <h3>{item.name}</h3>
                    <p>{item.created_at ? `Created ${date(item.created_at)}` : server?.region}</p>
                    <span className="card-link">
                      Browse bucket <ArrowRight size={13} />
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!bucketBusy && !buckets.length && !bucketError && (
              <Empty
                icon={<Database size={32} />}
                title="No buckets yet"
                text="Create a bucket on your S3 server, then refresh this workspace."
              />
            )}
          </>
        ) : (
          <>
            <div className="stats-grid">
              <Stat icon={<HardDrive size={19} />} label="CURRENT BUCKET" value={bucket} />
              <Stat
                icon={<File size={19} />}
                label="OBJECTS ON THIS PAGE"
                value={String(listing.objects.length)}
              />
              <Stat
                icon={<Folder size={19} />}
                label="FOLDERS ON THIS PAGE"
                value={String(listing.prefixes.length)}
              />
              <Stat
                icon={<Database size={19} />}
                label="SIZE ON THIS PAGE"
                value={bytes(totalSize)}
              />
            </div>
            <section className="objects-panel">
              <div className="pathbar">
                <Folder size={16} />
                <div className="breadcrumbs">
                  <span className="path-scheme">s3://</span>
                  <button type="button" onClick={() => navigate(bucket)}>
                    {bucket}
                  </button>
                  {parts.map((part, index) => (
                    <React.Fragment key={parts.slice(0, index + 1).join("/")}>
                      <span>/</span>
                      <button
                        type="button"
                        onClick={() => navigate(bucket, `${parts.slice(0, index + 1).join("/")}/`)}
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  ))}
                  <span>/</span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  title="Copy S3 path"
                  onClick={() =>
                    void (
                      navigator.clipboard?.writeText(`s3://${bucket}/${prefix}`) ??
                      Promise.reject(new Error("Clipboard unavailable"))
                    )
                      .then(() => notify("S3 path copied"))
                      .catch(() => notify("Clipboard unavailable", true))
                  }
                >
                  <Copy size={14} />
                </button>
              </div>
              <div className="toolbar">
                <div className="table-search">
                  <Search size={16} />
                  <input
                    aria-label="Search this page"
                    placeholder="Search this page…"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  {filter && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Clear search"
                      onClick={() => setFilter("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div className="toolbar-actions">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setModal({ type: "versions" })}
                  >
                    <History size={15} />
                    <span>Versions</span>
                  </button>
                  {selected.size > 0 && (
                    <button
                      type="button"
                      className="button danger subtle"
                      onClick={() => setModal({ type: "delete", keys: [...selected] })}
                    >
                      <Trash2 size={14} />
                      <span>Delete ({selected.size})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button refresh-button"
                    title="Refresh objects"
                    onClick={refresh}
                  >
                    <RefreshCw size={16} className={busy ? "spin" : ""} />
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setModal({ type: "folder" })}
                  >
                    <FolderPlus size={15} />
                    <span>New folder</span>
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => input.current?.click()}
                  >
                    <Plus size={16} />
                    <span>Upload files</span>
                  </button>
                  <input
                    ref={input}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Upload files"
                    onChange={(event) => {
                      void transferRef.current?.startUpload(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                </div>
              </div>
              {error ? (
                <div className="error-panel">
                  <Info size={18} />
                  <div>
                    <strong>Unable to load objects</strong>
                    <p>{error}</p>
                  </div>
                  <button type="button" className="button secondary" onClick={refresh}>
                    Retry
                  </button>
                </div>
              ) : busy ? (
                <Loading label="Loading objects…" />
              ) : (
                <ObjectRows
                  objects={objects}
                  folders={folders}
                  bucket={bucket}
                  prefix={prefix}
                  parts={parts}
                  filter={filter}
                  selected={selected}
                  setSelected={setSelected}
                  navigate={navigate}
                  setModal={setModal}
                  signed={signed}
                />
              )}
              <div className="table-footer">
                <span>
                  {folders.length + objects.length} items on this page{" "}
                  <span className="footer-separator">·</span>{" "}
                  {selected.size
                    ? `${selected.size} selected${[...selected].some((key) => !visibleKeys.includes(key)) ? " (includes hidden files)" : ""}`
                    : "Folders first"}
                </span>
                <div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Previous page"
                    disabled={page === 0 || busy}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    <ChevronRight size={15} className="rotate-180" />
                  </button>
                  <span>Page {page + 1}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Next page"
                    disabled={!listing.next_token || busy}
                    onClick={() => {
                      const token = listing.next_token;
                      if (!token) return;
                      setTokens((current) => [...current.slice(0, page + 1), token]);
                      setPage((value) => value + 1);
                    }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            </section>
            <div className="transfer-hint">
              <span>
                <UploadCloud size={16} />
                <span>Drag & drop files anywhere to upload to this folder.</span>
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={proxy}
                  onChange={(event) => setProxy(event.target.checked)}
                />
                Transfer through backend{" "}
                <CircleHelp size={14}>
                  <title>
                    Use for private endpoints or servers without browser CORS configuration.
                  </title>
                </CircleHelp>
              </label>
            </div>
          </>
        )}
        <footer className="main-footer">
          <span>
            STIVA BROWSER <span> / </span> YOUR STORAGE, SIMPLIFIED
          </span>
          <span>
            <ShieldCheck size={13} />
            Database-backed. Credentials encrypted.
          </span>
        </footer>
      </main>

      <Transfers
        serverName={server?.name ?? serverId}
        ref={transferRef}
        target={{ serverId, bucket, prefix }}
        proxy={proxy}
        contextKey={serverContext}
        notify={notify}
        onComplete={(target) => {
          if (
            target.serverId === workspace.current.serverId &&
            target.bucket === workspace.current.bucket &&
            target.prefix === workspace.current.prefix
          )
            refresh();
        }}
      />
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <Info size={17} /> : <Check size={17} />}
          <span>{notice.text}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {manager && (
        <ServerManager
          servers={servers}
          onClose={() => setManager(false)}
          onChange={loadServers}
          notify={notify}
        />
      )}
      {modal?.type === "folder-delete" && (
        <FolderDeleteModal
          serverId={serverId}
          bucket={bucket}
          prefix={modal.prefix}
          onClose={closeModal}
          onComplete={(deleted, errors) => {
            setModal(null);
            refresh();
            notify(
              errors.length
                ? `${deleted} deleted; ${errors.length} failed. ${errors.slice(0, 3).join(", ")}${errors.length > 3 ? "…" : ""}`
                : `${deleted} objects deleted`,
              errors.length > 0,
            );
          }}
        />
      )}
      {modal?.type === "versions" && (
        <VersionsModal
          serverId={serverId}
          bucket={bucket}
          prefix={prefix}
          objectKey={modal.key}
          onClose={closeModal}
          onChange={refresh}
        />
      )}
      {modal?.type === "folder" && (
        <FolderModal
          onClose={closeModal}
          onCreate={async (name) => {
            await api(
              `${bucketPath(bucket)}/folders`,
              {
                method: "POST",
                body: JSON.stringify({ key: `${prefix}${name}/` }),
              },
              serverId,
            );
            setModal(null);
            refresh();
            notify("Folder created");
          }}
        />
      )}
      {modal?.type === "delete" && (
        <DeleteModal
          keys={modal.keys}
          onClose={closeModal}
          onDelete={async () => {
            const result = await deleteObjects(serverId, bucket, modal.keys);
            setModal(null);
            refresh();
            if (result.errors.length)
              notify(
                `${result.deleted.length} deleted. Failed or unconfirmed: ${result.errors.map((e) => `${e.key} (${e.code})`).join(", ")}`,
                true,
              );
            else
              notify(
                `${result.deleted.length} object${result.deleted.length === 1 ? "" : "s"} deleted`,
              );
          }}
        />
      )}
      {modal?.type === "inspect" && (
        <InspectModal
          key={`${serverId}:${bucket}:${modal.object.key}`}
          serverId={serverId}
          bucket={bucket}
          object={modal.object}
          preview={modal.preview}
          onClose={closeModal}
          onCopy={() => void signed(modal.object)}
          onVersions={() => setModal({ type: "versions", key: modal.object.key })}
        />
      )}
      {modal?.type === "link" && <LinkModal signed={modal.signed} onClose={closeModal} />}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
