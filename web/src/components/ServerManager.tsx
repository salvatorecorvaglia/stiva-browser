import {
  ArrowRight,
  Check,
  Info,
  LoaderCircle,
  Plus,
  Server as ServerIcon,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api, type Server } from "../api";
import { Dialog } from "../Dialog";

type Notice = { text: string; error?: boolean };
const blankServer = {
  name: "",
  endpoint_url: "",
  region: "us-east-1",
  access_key: "",
  secret_key: "",
  force_path_style: true,
};
export function ServerManager({
  servers,
  onClose,
  onChange,
  notify,
}: {
  servers: Server[];
  onClose: () => void;
  onChange: (savedId?: string) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<string>();
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
    setEditingRevision(server?.revision);
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
      const saved = await api<Server>(editing ? `/api/servers/${editing}` : "/api/servers", {
        method: editing ? "PUT" : "POST",
        headers: editingRevision ? { "If-Match": `"${editingRevision}"` } : undefined,
        body: JSON.stringify(payload()),
        signal: pending.signal,
      });
      await onChange(saved.id);
      if (pending.signal.aborted) return;
      notify(editing ? "Server updated" : "Server connected");
      onClose();
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
      const result = await api<{ bucket_count: number; has_more?: boolean }>("/api/servers/test", {
        method: "POST",
        body: JSON.stringify({ ...payload(), id: editing ?? undefined }),
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      setTest({
        text: `Connected successfully · ${result.bucket_count}${result.has_more ? "+" : ""} buckets available`,
      });
    } catch (err) {
      if (!pending.signal.aborted) setTest({ text: (err as Error).message, error: true });
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
              <button type="button" disabled={working} onClick={() => choose(server)}>
                <ServerIcon size={17} />
                <span>
                  <strong>{server.name}</strong>
                  <small>{server.region}</small>
                </span>
              </button>
              <button
                type="button"
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
                    type="button"
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
                  <button type="button" className="text-button" onClick={() => setDeleting(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            className="add-server-link"
            disabled={working}
            onClick={() => choose()}
          >
            <Plus size={15} />
            Add a server
          </button>
        </div>
        <form className="server-form" onSubmit={save}>
          <fieldset disabled={working}>
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
                  placeholder={editing ? "Leave blank to keep current" : "Access key ID"}
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
                  placeholder={editing ? "Leave blank to keep current" : "Secret access key"}
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
                <small>Recommended for MinIO and most S3-compatible providers.</small>
              </span>
            </label>
            {test && (
              <div className={`form-message ${test.error ? "error" : "success"}`} role="status">
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
                {working ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}
                Test connection
              </button>
              <button type="submit" className="button primary" disabled={working}>
                {working ? "Please wait…" : editing ? "Save changes" : "Add server"}
                <ArrowRight size={15} />
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </Dialog>
  );
}
