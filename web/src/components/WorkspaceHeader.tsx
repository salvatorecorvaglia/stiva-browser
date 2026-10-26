import { Archive, ChevronDown, Menu, Server as ServerIcon, Settings2 } from "lucide-react";
import type { Dispatch, Ref, SetStateAction } from "react";
import type { Server } from "../api";
import { ThemePicker } from "./ThemePicker";

export function WorkspaceHeader({
  servers,
  serverId,
  connected,
  sidebar,
  sidebarToggle,
  setSidebar,
  switchServer,
  setManager,
}: {
  servers: Server[];
  serverId: string;
  connected: boolean | null;
  sidebar: boolean;
  sidebarToggle: Ref<HTMLButtonElement>;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  switchServer: (id: string) => void;
  setManager: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button mobile-menu"
        ref={sidebarToggle}
        aria-expanded={sidebar}
        aria-controls="bucket-sidebar"
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
        <ThemePicker />
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
          type="button"
          className="button secondary manage-button"
          aria-label="Manage servers"
          onClick={() => setManager(true)}
        >
          <Settings2 size={15} />
          <span>Manage servers</span>
        </button>
      </div>
    </header>
  );
}
