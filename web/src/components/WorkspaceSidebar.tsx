import {
  Cloud,
  Database,
  Ellipsis,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Bucket, Server } from "../api";

export function WorkspaceSidebar({
  buckets,
  bucket,
  serverId,
  server,
  mobile,
  sidebar,
  bucketBusy,
  bucketFilter,
  setBucketFilter,
  setBucketRevision,
  setManager,
  setSidebar,
  sidebarToggle,
  navigate,
}: {
  buckets: Bucket[];
  bucket: string;
  serverId: string;
  server?: Server;
  mobile: boolean;
  sidebar: boolean;
  bucketBusy: boolean;
  bucketFilter: string;
  setBucketFilter: Dispatch<SetStateAction<string>>;
  setBucketRevision: Dispatch<SetStateAction<number>>;
  setManager: Dispatch<SetStateAction<boolean>>;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  sidebarToggle: RefObject<HTMLButtonElement | null>;
  navigate: (bucket: string, prefix?: string) => void;
}) {
  return (
    <>
      {" "}
      <aside
        id="bucket-sidebar"
        inert={mobile && !sidebar}
        className={`sidebar ${sidebar ? "open" : ""}`}
      >
        <div className="sidebar-heading">
          <span>WORKSPACE</span>
          <span className="tag">S3</span>
          <button
            type="button"
            className="icon-button sidebar-close"
            aria-label="Close bucket navigation"
            onClick={() => {
              setSidebar(false);
              sidebarToggle.current?.focus();
            }}
          >
            <X size={16} />
          </button>
        </div>
        <button
          type="button"
          className={`overview-link ${!bucket ? "active" : ""}`}
          onClick={() => navigate("")}
        >
          <Database size={17} />
          All buckets<span>{buckets.length}</span>
        </button>
        <div className="bucket-heading">
          <span>BUCKETS</span>
          <button
            type="button"
            className="icon-button"
            title="Reload buckets"
            onClick={() => setBucketRevision((value) => value + 1)}
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
              .filter((item) => item.name.toLowerCase().includes(bucketFilter.toLowerCase()))
              .map((item) => (
                <button
                  type="button"
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
              {serverId ? "No buckets available" : "Connect a server to get started"}
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
              type="button"
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
          type="button"
          className="sidebar-backdrop"
          aria-label="Dismiss bucket navigation"
          onClick={() => {
            setSidebar(false);
            sidebarToggle.current?.focus();
          }}
        />
      )}
    </>
  );
}
