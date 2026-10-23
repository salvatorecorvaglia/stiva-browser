import { Archive, File, FileCode2, FileImage, FileText, LoaderCircle } from "lucide-react";
import type React from "react";
export function Stat({
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
export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={25} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function Empty({
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
export function FileIcon({ name }: { name: string }) {
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
