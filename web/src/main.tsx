import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  Database,
  Ellipsis,
  Eye,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Info,
  LoaderCircle,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Server as ServerIcon,
  Settings2,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  api,
  bucketPath,
  bytes,
  date,
  streamUrl,
  uploadFile,
  type Server,
  type Bucket,
  type S3Object,
  type Listing,
  type Metadata,
  type Signed,
} from "./api";
import "./styles.css";

type Notice = { text: string; error?: boolean };
type Modal =
  | { type: "folder" }
  | { type: "delete"; keys: string[] }
  | { type: "inspect"; object: S3Object; preview: boolean }
  | { type: "link"; signed: Signed }
  | null;
type Transfer = {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error" | "canceled";
  message?: string;
  file: File;
  serverId: string;
  bucket: string;
  prefix: string;
};

function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [serverId, setServerId] = useState("");
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState<Listing>({
    objects: [],
    prefixes: [],
    next_token: null,
  });
  const [tokens, setTokens] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [bucketBusy, setBucketBusy] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [bucketError, setBucketError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [manager, setManager] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [filter, setFilter] = useState("");
  const [bucketFilter, setBucketFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Modal>(null);
  const [proxy, setProxy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const contextVersion = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const server = servers.find((item) => item.id === serverId);
  const notify = (text: string, error = false) => setNotice({ text, error });

  async function loadServers() {
    const result = await api<Server[]>("/api/servers");
    setServers(result);
    setServerId((current) =>
      result.some((item) => item.id === current)
        ? current
        : (result[0]?.id ?? ""),
    );
  }
  useEffect(() => {
    void loadServers().catch((err) => notify(err.message, true));
    return () => {
      controllers.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(
      () => setNotice(null),
      notice.error ? 10000 : 4500,
    );
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    contextVersion.current++;
    controllers.current.forEach((controller) => controller.abort());
    setBucket("");
    setBuckets([]);
    setConnected(null);
    setBucketError("");
    if (!serverId) return;
    const controller = new AbortController();
    setBucketBusy(true);
    api<{ buckets: Bucket[] }>(
      "/api/buckets",
      { signal: controller.signal },
      serverId,
    )
      .then((result) => {
        setBuckets(result.buckets);
        setConnected(true);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setBucketError(err.message);
          setConnected(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBucketBusy(false);
      });
    return () => controller.abort();
  }, [serverId, servers]);
  useEffect(() => {
    setSelected(new Set());
    setError("");
    if (!bucket || !serverId) {
      setListing({ objects: [], prefixes: [], next_token: null });
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const query = new URLSearchParams({ prefix });
    if (tokens[page]) query.set("continuationToken", tokens[page]!);
    api<Listing>(
      `${bucketPath(bucket)}/objects?${query}`,
      { signal: controller.signal },
      serverId,
    )
      .then(setListing)
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message);
          setListing({ objects: [], prefixes: [], next_token: null });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [serverId, bucket, prefix, page, revision]);

  function navigate(nextBucket: string, nextPrefix = "") {
    setBucket(nextBucket);
    setPrefix(nextPrefix);
    setPage(0);
    setTokens([undefined]);
    setFilter("");
    setSelected(new Set());
    setSidebar(false);
    setModal(null);
  }
  function switchServer(id: string) {
    contextVersion.current++;
    controllers.current.forEach((controller) => controller.abort());
    setServerId(id);
    navigate("");
    setListing({ objects: [], prefixes: [], next_token: null });
  }
  function refresh() {
    setPage(0);
    setTokens([undefined]);
    setRevision((value) => value + 1);
  }
  async function signed(object: S3Object, download = false) {
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

  async function startUpload(
    files: File[],
    throughBackend = proxy,
    target = { serverId, bucket, prefix },
  ) {
    if (!target.serverId || !target.bucket) return;
    const version = contextVersion.current;
    for (const file of files) {
      if (version !== contextVersion.current) break;
      const key = target.prefix + file.name;
      if (new TextEncoder().encode(key).length > 1024) {
        notify(`${file.name}: object key exceeds 1024 bytes`, true);
        continue;
      }
      try {
        await api<Metadata>(
          `${bucketPath(target.bucket)}/objects/metadata?${new URLSearchParams({ key })}`,
          {},
          target.serverId,
        );
        if (!window.confirm(`Replace existing object “${file.name}”?`))
          continue;
      } catch (err) {
        if (!(err as Error).message.includes("not found")) {
          notify((err as Error).message, true);
          continue;
        }
      }
      if (version !== contextVersion.current) break;
      const id = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      setTransfers((current) => [
        ...current,
        {
          id,
          name: file.name,
          file,
          serverId: target.serverId,
          bucket: target.bucket,
          prefix: target.prefix,
          progress: 0,
          status: "uploading",
        },
      ]);
      const patch = (change: Partial<Transfer>) =>
        setTransfers((current) =>
          current.map((item) =>
            item.id === id ? { ...item, ...change } : item,
          ),
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
        await uploadFile(url, file, headers, controller.signal, (progress) =>
          patch({ progress }),
        );
        patch({ progress: 100, status: "done" });
        refresh();
      } catch (err) {
        patch({
          status: controller.signal.aborted ? "canceled" : "error",
          message: (err as Error).message,
        });
      } finally {
        controllers.current.delete(id);
      }
    }
  }

  const folders = listing.prefixes.filter((key) =>
    key.toLowerCase().includes(filter.toLowerCase()),
  );
  const objects = listing.objects.filter((object) =>
    object.key.toLowerCase().includes(filter.toLowerCase()),
  );
  const visibleKeys = objects.map((object) => object.key);
  const totalSize = listing.objects.reduce(
    (sum, object) => sum + object.size,
    0,
  );
  const parts = prefix ? prefix.slice(0, -1).split("/") : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="icon-button mobile-menu"
          aria-label="Toggle buckets"
          onClick={() => setSidebar((value) => !value)}
        >
          <Menu size={20} />
        </button>
        <a className="brand" href="/" aria-label="Stiva Browser home">
          <span className="brand-mark">
            <Archive size={23} />
          </span>
          <span>
            stiva<span className="brand-dot">.</span>
            <small>BROWSER</small>
          </span>
        </a>
        <div className="workspace-label">S3 workspace</div>
        <div className="topbar-right">
          <div className="server-selector">
            <ServerIcon size={15} />
            <select
              aria-label="Select S3 server"
              value={serverId}
              onChange={(event) => switchServer(event.target.value)}
            >
              <option value="" disabled>
                {servers.length ? "Select a server" : "No servers connected"}
              </option>
              {servers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </div>
          <span
            className={`connection ${connected === true ? "online" : connected === false ? "offline" : ""}`}
          >
            <i />
            {connected === true
              ? "Connected"
              : connected === false
                ? "Disconnected"
                : serverId
                  ? "Connecting"
                  : "Not connected"}
          </span>
          <button
            className="button secondary manage-button"
            aria-label="Manage servers"
            onClick={() => setManager(true)}
          >
            <Settings2 size={15} />
            <span>Manage servers</span>
          </button>
        </div>
      </header>

      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <div className="sidebar-heading">
          <span>WORKSPACE</span>
          <span className="tag">S3</span>
        </div>
        <button
          className={`overview-link ${!bucket ? "active" : ""}`}
          onClick={() => navigate("")}
        >
          <Database size={17} />
          All buckets<span>{buckets.length}</span>
        </button>
        <div className="bucket-heading">
          <span>BUCKETS</span>
          <button
            className="icon-button"
            title="Reload buckets"
            onClick={() =>
              void loadServers().catch((err) => notify(err.message, true))
            }
          >
            <RefreshCw size={13} className={bucketBusy ? "spin" : ""} />
          </button>
        </div>
        <div className="sidebar-search">
          <Search size={14} />
          <input
            aria-label="Filter buckets"
            placeholder="Find a bucket…"
            value={bucketFilter}
            onChange={(event) => setBucketFilter(event.target.value)}
          />
          <kbd>⌕</kbd>
        </div>
        <nav aria-label="Buckets" className="bucket-nav">
          {bucketBusy ? (
            <div className="sidebar-empty">
              <LoaderCircle size={16} className="spin" /> Loading buckets
            </div>
          ) : (
            buckets
              .filter((item) =>
                item.name.toLowerCase().includes(bucketFilter.toLowerCase()),
              )
              .map((item) => (
                <button
                  key={item.name}
                  className={`bucket-link ${bucket === item.name ? "active" : ""}`}
                  onClick={() => navigate(item.name)}
                >
                  <HardDrive size={16} />
                  <span>{item.name}</span>
                  {bucket === item.name && <span className="active-dot" />}
                </button>
              ))
          )}
          {!bucketBusy && !buckets.length && (
            <div className="sidebar-empty">
              {serverId
                ? "No buckets available"
                : "Connect a server to get started"}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="server-card">
            <span className="server-card-icon">
              <Cloud size={19} />
            </span>
            <div>
              <strong>{server?.name ?? "Your storage, connected"}</strong>
              <small>{server?.region ?? "Any S3-compatible server"}</small>
            </div>
            <button
              className="icon-button"
              aria-label="Manage server"
              onClick={() => setManager(true)}
            >
              <Ellipsis size={17} />
            </button>
          </div>
          <div className="sidebar-footer">
            <ShieldCheck size={13} />
            <span>Credentials encrypted at rest</span>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close bucket navigation"
          onClick={() => setSidebar(false)}
        />
      )}

      <main
        className="main"
        onDragOver={(event) => {
          if (bucket && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
      >
        {dragging && (
          <div
            className="drop-overlay"
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void startUpload(Array.from(event.dataTransfer.files));
            }}
          >
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
            <button className="button primary" onClick={() => setManager(true)}>
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
                <button
                  className="button secondary"
                  onClick={() => setManager(true)}
                >
                  Check configuration
                </button>
              </div>
            )}
            <div className="section-title">
              <h2>
                Buckets <span>{buckets.length}</span>
              </h2>
              <button
                className="button secondary"
                onClick={() =>
                  void loadServers().catch((err) => notify(err.message, true))
                }
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
                    className="bucket-card"
                    key={item.name}
                    onClick={() => navigate(item.name)}
                  >
                    <span className="bucket-card-icon">
                      <HardDrive size={24} />
                    </span>
                    <ChevronRight size={17} className="card-arrow" />
                    <h3>{item.name}</h3>
                    <p>
                      {item.created_at
                        ? `Created ${date(item.created_at)}`
                        : server?.region}
                    </p>
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
              <Stat
                icon={<HardDrive size={19} />}
                label="CURRENT BUCKET"
                value={bucket}
              />
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
                  <button onClick={() => navigate("")}>{server?.name}</button>
                  <span>/</span>
                  <button onClick={() => navigate(bucket)}>{bucket}</button>
                  {parts.map((part, index) => (
                    <React.Fragment key={index}>
                      <span>/</span>
                      <button
                        onClick={() =>
                          navigate(
                            bucket,
                            parts.slice(0, index + 1).join("/") + "/",
                          )
                        }
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  ))}
                  <span>/</span>
                </div>
                <button
                  className="icon-button"
                  title="Copy S3 path"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(`s3://${server?.name}/${bucket}/${prefix}`)
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
                      className="icon-button"
                      aria-label="Clear search"
                      onClick={() => setFilter("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div className="toolbar-actions">
                  {selected.size > 0 && (
                    <button
                      className="button danger subtle"
                      onClick={() =>
                        setModal({ type: "delete", keys: [...selected] })
                      }
                    >
                      <Trash2 size={14} />
                      <span>Delete ({selected.size})</span>
                    </button>
                  )}
                  <button
                    className="icon-button refresh-button"
                    title="Refresh objects"
                    onClick={refresh}
                  >
                    <RefreshCw size={16} className={busy ? "spin" : ""} />
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setModal({ type: "folder" })}
                  >
                    <FolderPlus size={15} />
                    <span>New folder</span>
                  </button>
                  <button
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
                      void startUpload(Array.from(event.target.files ?? []));
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
                  <button className="button secondary" onClick={refresh}>
                    Retry
                  </button>
                </div>
              ) : busy ? (
                <Loading label="Loading objects…" />
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="checkbox-cell">
                          <input
                            type="checkbox"
                            aria-label="Select all files on this page"
                            checked={
                              visibleKeys.length > 0 &&
                              visibleKeys.every((key) => selected.has(key))
                            }
                            disabled={!visibleKeys.length}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? new Set(visibleKeys)
                                  : new Set(),
                              )
                            }
                          />
                        </th>
                        <th>
                          Name <ChevronDown size={12} />
                        </th>
                        <th>Size</th>
                        <th>Last modified</th>
                        <th className="actions-heading">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!!prefix && (
                        <tr>
                          <td />
                          <td>
                            <button
                              className="object-name"
                              onClick={() =>
                                navigate(
                                  bucket,
                                  parts.slice(0, -1).join("/") +
                                    (parts.length > 1 ? "/" : ""),
                                )
                              }
                            >
                              <span className="file-icon folder">
                                <ArrowLeft size={17} />
                              </span>
                              <span>Parent folder</span>
                            </button>
                          </td>
                          <td>—</td>
                          <td>—</td>
                          <td />
                        </tr>
                      )}
                      {folders.sort().map((key) => (
                        <tr key={key}>
                          <td />
                          <td>
                            <button
                              className="object-name"
                              onClick={() => navigate(bucket, key)}
                            >
                              <span className="file-icon folder">
                                <Folder size={19} />
                              </span>
                              <span>
                                {key.slice(prefix.length).replace(/\/$/, "") ||
                                  "(empty segment)"}
                              </span>
                              <ChevronRight
                                size={13}
                                className="folder-arrow"
                              />
                            </button>
                          </td>
                          <td className="muted">Folder</td>
                          <td>—</td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="icon-button delete-action"
                                title={`Delete folder marker ${key}`}
                                onClick={() =>
                                  setModal({ type: "delete", keys: [key] })
                                }
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {objects
                        .sort((a, b) => a.key.localeCompare(b.key))
                        .map((object) => (
                          <tr
                            key={object.key}
                            className={
                              selected.has(object.key) ? "selected" : ""
                            }
                          >
                            <td className="checkbox-cell">
                              <input
                                type="checkbox"
                                aria-label={`Select ${object.key}`}
                                checked={selected.has(object.key)}
                                onChange={() =>
                                  setSelected((current) => {
                                    const next = new Set(current);
                                    if (next.has(object.key))
                                      next.delete(object.key);
                                    else next.add(object.key);
                                    return next;
                                  })
                                }
                              />
                            </td>
                            <td>
                              <button
                                className="object-name"
                                onClick={() =>
                                  setModal({
                                    type: "inspect",
                                    object,
                                    preview: true,
                                  })
                                }
                              >
                                <FileIcon name={object.key} />
                                <span>{object.key.slice(prefix.length)}</span>
                              </button>
                            </td>
                            <td className="size-cell">{bytes(object.size)}</td>
                            <td className="date-cell">
                              {date(object.last_modified)}
                            </td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className="icon-button"
                                  title={`Preview ${object.key}`}
                                  onClick={() =>
                                    setModal({
                                      type: "inspect",
                                      object,
                                      preview: true,
                                    })
                                  }
                                >
                                  <Eye size={15} />
                                </button>
                                <button
                                  className="icon-button"
                                  title="Copy presigned URL"
                                  onClick={() => void signed(object)}
                                >
                                  <Copy size={14} />
                                </button>
                                <button
                                  className="icon-button"
                                  title="Download through backend"
                                  onClick={() => void signed(object, true)}
                                >
                                  <ArrowDownToLine size={15} />
                                </button>
                                <button
                                  className="icon-button"
                                  title="Object metadata"
                                  onClick={() =>
                                    setModal({
                                      type: "inspect",
                                      object,
                                      preview: false,
                                    })
                                  }
                                >
                                  <Info size={15} />
                                </button>
                                <button
                                  className="icon-button delete-action"
                                  title={`Delete ${object.key}`}
                                  onClick={() =>
                                    setModal({
                                      type: "delete",
                                      keys: [object.key],
                                    })
                                  }
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {!objects.length && !folders.length && (
                    <Empty
                      icon={<Folder size={30} />}
                      title={
                        filter
                          ? "No matching objects"
                          : "A little room for something new"
                      }
                      text={
                        filter
                          ? "Try another search. Search applies to this page."
                          : "Drop files here or use Upload files to get started."
                      }
                    />
                  )}
                </div>
              )}
              <div className="table-footer">
                <span>
                  {folders.length + objects.length} items on this page{" "}
                  <span className="footer-separator">·</span>{" "}
                  {selected.size
                    ? `${selected.size} selected`
                    : "Folders first"}
                </span>
                <div>
                  <button
                    className="icon-button"
                    aria-label="Previous page"
                    disabled={page === 0 || busy}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    <ChevronRight size={15} className="rotate-180" />
                  </button>
                  <span>Page {page + 1}</span>
                  <button
                    className="icon-button"
                    aria-label="Next page"
                    disabled={!listing.next_token || busy}
                    onClick={() => {
                      setTokens((current) => [
                        ...current.slice(0, page + 1),
                        listing.next_token!,
                      ]);
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
                <span>
                  Drag & drop files anywhere to upload to this folder.
                </span>
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
                    Use for private endpoints or servers without browser CORS
                    configuration.
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

      {!!transfers.length && (
        <section className="transfers" aria-label="File transfers">
          <div className="transfers-heading">
            <strong>
              <UploadCloud size={16} />
              Transfers
            </strong>
            <button
              className="icon-button"
              title="Dismiss completed transfers"
              onClick={() =>
                setTransfers((current) =>
                  current.filter((item) => item.status === "uploading"),
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
                {item.status === "uploading" ? (
                  <button
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
              <small>
                {item.status === "uploading"
                  ? `${item.progress}% · ${item.progress === 100 ? "Finishing…" : "Uploading"}`
                  : (item.message ??
                    (item.status === "done" ? "Upload complete" : "Canceled"))}
              </small>
              <div className="progress-track">
                <i style={{ width: `${item.progress}%` }} />
              </div>
              {item.status === "error" && (
                <button
                  className="text-button"
                  onClick={() => {
                    setTransfers((current) =>
                      current.filter((t) => t.id !== item.id),
                    );
                    void startUpload([item.file], true, item);
                  }}
                >
                  Retry through backend
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <Info size={17} /> : <Check size={17} />}
          <span>{notice.text}</span>
          <button
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
      {modal?.type === "folder" && (
        <FolderModal
          onClose={() => setModal(null)}
          onCreate={async (name) => {
            await api(
              `${bucketPath(bucket)}/folders`,
              {
                method: "POST",
                body: JSON.stringify({ key: prefix + name + "/" }),
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
          onClose={() => setModal(null)}
          onDelete={async () => {
            const result = await api<{
              deleted: string[];
              errors: { key: string; code: string }[];
            }>(
              `${bucketPath(bucket)}/objects`,
              { method: "DELETE", body: JSON.stringify({ keys: modal.keys }) },
              serverId,
            );
            setModal(null);
            refresh();
            if (result.errors.length)
              notify(
                `${result.deleted.length} deleted. Failed: ${result.errors.map((e) => `${e.key} (${e.code})`).join(", ")}`,
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
          onClose={() => setModal(null)}
          onCopy={() => void signed(modal.object)}
        />
      )}
      {modal?.type === "link" && (
        <LinkModal signed={modal.signed} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="stat">
      <span className="stat-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong title={value}>{value}</strong>
      </div>
    </div>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={25} className="spin" />
      <span>{label}</span>
    </div>
  );
}
function Empty({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function FileIcon({ name }: { name: string }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const image = /^(png|jpg|jpeg|gif|webp|svg|avif)$/.test(extension);
  const code = /^(json|js|ts|html|css|xml|yaml|yml)$/.test(extension);
  const archive = /^(zip|gz|tar|7z)$/.test(extension);
  return (
    <span
      className={`file-icon ${image ? "image" : code ? "code" : archive ? "archive" : "document"}`}
    >
      {image ? (
        <FileImage size={18} />
      ) : code ? (
        <FileCode2 size={18} />
      ) : archive ? (
        <Archive size={18} />
      ) : /^(txt|md|csv|pdf)$/.test(extension) ? (
        <FileText size={18} />
      ) : (
        <File size={18} />
      )}
    </span>
  );
}

function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    root.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const elements = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, a[href], [tabindex="0"]',
        ),
      ];
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === root)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === root)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handle);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handle);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const blankServer = {
  name: "",
  endpoint_url: "",
  region: "us-east-1",
  access_key: "",
  secret_key: "",
  force_path_style: true,
};
function ServerManager({
  servers,
  onClose,
  onChange,
  notify,
}: {
  servers: Server[];
  onClose: () => void;
  onChange: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(blankServer);
  const [working, setWorking] = useState(false);
  const [test, setTest] = useState<Notice | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const choose = (server?: Server) => {
    controller.current?.abort();
    setWorking(false);
    setEditing(server?.id ?? null);
    setForm(
      server
        ? {
            name: server.name,
            endpoint_url: server.endpoint_url,
            region: server.region,
            access_key: "",
            secret_key: "",
            force_path_style: server.force_path_style,
          }
        : blankServer,
    );
    setTest(null);
    setError("");
    setDeleting(null);
  };
  const payload = () => ({
    ...form,
    access_key: form.access_key || undefined,
    secret_key: form.secret_key || undefined,
  });
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    setError("");
    const pending = new AbortController();
    controller.current = pending;
    try {
      await api(editing ? `/api/servers/${editing}` : "/api/servers", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(payload()),
        signal: pending.signal,
      });
      await onChange();
      choose();
      notify(editing ? "Server updated" : "Server connected");
    } catch (err) {
      if (!pending.signal.aborted) setError((err as Error).message);
    } finally {
      if (!pending.signal.aborted) setWorking(false);
    }
  }
  async function testConnection() {
    setWorking(true);
    setTest(null);
    const pending = new AbortController();
    controller.current = pending;
    try {
      const result = await api<{ bucket_count: number }>("/api/servers/test", {
        method: "POST",
        body: JSON.stringify({ ...payload(), id: editing ?? undefined }),
        signal: pending.signal,
      });
      setTest({
        text: `Connected successfully · ${result.bucket_count} buckets available`,
      });
    } catch (err) {
      if (!pending.signal.aborted)
        setTest({ text: (err as Error).message, error: true });
    } finally {
      if (!pending.signal.aborted) setWorking(false);
    }
  }
  return (
    <Dialog
      wide
      title="Manage servers"
      subtitle="Connect your S3-compatible storage. Credentials stay encrypted in your database."
      onClose={onClose}
    >
      <div className="server-manager">
        <div className="saved-servers">
          <div className="saved-heading">
            YOUR SERVERS <span>{servers.length}</span>
          </div>
          {servers.map((server) => (
            <div
              key={server.id}
              className={`saved-server ${editing === server.id ? "active" : ""}`}
            >
              <button onClick={() => choose(server)}>
                <ServerIcon size={17} />
                <span>
                  <strong>{server.name}</strong>
                  <small>{server.region}</small>
                </span>
              </button>
              <button
                className="icon-button delete-action"
                aria-label={`Remove ${server.name}`}
                onClick={() => setDeleting(server.id)}
              >
                <Trash2 size={14} />
              </button>
              {deleting === server.id && (
                <div className="remove-confirm">
                  <p>Remove this configuration? Bucket contents stay on S3.</p>
                  <button
                    className="button danger"
                    disabled={working}
                    onClick={async () => {
                      setWorking(true);
                      try {
                        await api(`/api/servers/${server.id}`, {
                          method: "DELETE",
                        });
                        await onChange();
                        choose();
                        notify("Server removed");
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setWorking(false);
                      }
                    }}
                  >
                    Remove
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
          <button className="add-server-link" onClick={() => choose()}>
            <Plus size={15} />
            Add a server
          </button>
        </div>
        <form className="server-form" onSubmit={save}>
          <h3>{editing ? "Edit server" : "Connect a new server"}</h3>
          <label>
            Server name
            <input
              required
              maxLength={120}
              placeholder="e.g. Production storage"
              value={form.name}
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
                setTest(null);
              }}
            />
          </label>
          <label>
            Endpoint URL
            <input
              required
              type="url"
              placeholder="https://s3.us-east-1.amazonaws.com"
              value={form.endpoint_url}
              onChange={(event) => {
                setForm({ ...form, endpoint_url: event.target.value });
                setTest(null);
              }}
            />
          </label>
          <label>
            Region
            <input
              required
              placeholder="us-east-1"
              value={form.region}
              onChange={(event) => {
                setForm({ ...form, region: event.target.value });
                setTest(null);
              }}
            />
          </label>
          <div className="form-columns">
            <label>
              Access key
              <input
                required={!editing}
                autoComplete="off"
                placeholder={
                  editing ? "Leave blank to keep current" : "Access key ID"
                }
                value={form.access_key}
                onChange={(event) => {
                  setForm({ ...form, access_key: event.target.value });
                  setTest(null);
                }}
              />
            </label>
            <label>
              Secret key
              <input
                required={!editing}
                type="password"
                autoComplete="new-password"
                placeholder={
                  editing ? "Leave blank to keep current" : "Secret access key"
                }
                value={form.secret_key}
                onChange={(event) => {
                  setForm({ ...form, secret_key: event.target.value });
                  setTest(null);
                }}
              />
            </label>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.force_path_style}
              onChange={(event) => {
                setForm({ ...form, force_path_style: event.target.checked });
                setTest(null);
              }}
            />
            <span>
              Use path-style addressing
              <small>
                Recommended for MinIO and most S3-compatible providers.
              </small>
            </span>
          </label>
          {test && (
            <div
              className={`form-message ${test.error ? "error" : "success"}`}
              role="status"
            >
              {test.error ? <Info size={16} /> : <Check size={16} />}
              <span>{test.text}</span>
            </div>
          )}
          {error && (
            <div className="form-message error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="button secondary"
              disabled={working || !form.endpoint_url || !form.name}
              onClick={() => void testConnection()}
            >
              {working ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ShieldCheck size={15} />
              )}
              Test connection
            </button>
            <button className="button primary" disabled={working}>
              {working
                ? "Please wait…"
                : editing
                  ? "Save changes"
                  : "Add server"}
              <ArrowRight size={15} />
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function LinkModal({
  signed,
  onClose,
}: {
  signed: Signed;
  onClose: () => void;
}) {
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
            {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
            {copied ? "Copied" : "Copy URL"}
          </button>
          <a
            className="button primary"
            href={signed.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ArrowDownToLine size={15} />
            Open download
          </a>
        </div>
      </div>
    </Dialog>
  );
}

function FolderModal({
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
      onClose={onClose}
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
          <button className="button primary" disabled={working}>
            <FolderPlus size={15} />
            {working ? "Creating…" : "Create folder"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function DeleteModal({
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
      onClose={onClose}
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
          On versioned buckets, S3 versioning rules apply. Folder contents are
          never deleted recursively.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
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
function InspectModal({
  serverId,
  bucket,
  object,
  preview,
  onClose,
  onCopy,
}: {
  serverId: string;
  bucket: string;
  object: S3Object;
  preview: boolean;
  onClose: () => void;
  onCopy: () => void;
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(preview ? "preview" : "details");
  useEffect(() => {
    const controller = new AbortController();
    let blobUrl = "";
    async function load() {
      try {
        const result = await api<Metadata>(
          `${bucketPath(bucket)}/objects/metadata?${new URLSearchParams({ key: object.key })}`,
          { signal: controller.signal },
          serverId,
        );
        setMetadata(result);
        const mime = result.content_type?.split(";")[0].toLowerCase() ?? "";
        if (
          result.size === 0 &&
          ["text/plain", "text/csv", "application/json"].includes(mime)
        ) {
          setText("");
          return;
        }
        if (
          /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) &&
          result.size > 1048576
        ) {
          setError(
            "This image is too large to preview. Download it to view the full file.",
          );
          return;
        }
        if (
          ![
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
            "text/plain",
            "text/csv",
            "application/json",
          ].includes(mime)
        ) {
          setError(
            "Preview is unavailable for this file type. Download the object to open it.",
          );
          return;
        }
        const response = await fetch(
          streamUrl(serverId, bucket, object.key, true),
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Could not load preview");
        if (mime.startsWith("image/")) {
          blobUrl = URL.createObjectURL(await response.blob());
          setImage(blobUrl);
        } else setText(await response.text());
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [serverId, bucket, object.key]);
  return (
    <Dialog
      wide
      title={object.key.split("/").pop() || object.key}
      subtitle={`${bucket} / ${object.key}`}
      onClose={onClose}
    >
      <div className="inspect-tabs">
        <button
          className={tab === "preview" ? "active" : ""}
          onClick={() => setTab("preview")}
        >
          <Eye size={15} />
          Preview
        </button>
        <button
          className={tab === "details" ? "active" : ""}
          onClick={() => setTab("details")}
        >
          <Info size={15} />
          Metadata
        </button>
      </div>
      <div className="inspect-content">
        {loading ? (
          <Loading label="Loading object…" />
        ) : tab === "preview" ? (
          error ? (
            <Empty
              icon={<File size={30} />}
              title="Preview unavailable"
              text={error}
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
        <button className="button secondary" onClick={onCopy}>
          <Copy size={15} />
          Copy presigned URL
        </button>
        <a
          className="button primary"
          href={streamUrl(serverId, bucket, object.key)}
        >
          <ArrowDownToLine size={15} />
          Download
        </a>
      </div>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
