import {
  ArrowDownToLine,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Folder,
  Info,
  Trash2,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { bytes, date, type S3Object } from "../api";
import type { WorkspaceModal } from "../types";
import { Empty, FileIcon } from "./Primitives";

export function ObjectRows({
  objects,
  folders,
  bucket,
  prefix,
  parts,
  filter,
  selected,
  setSelected,
  navigate,
  setModal,
  signed,
}: {
  objects: S3Object[];
  folders: string[];
  bucket: string;
  prefix: string;
  parts: string[];
  filter: string;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  navigate: (bucket: string, prefix?: string) => void;
  setModal: Dispatch<SetStateAction<WorkspaceModal>>;
  signed: (object: S3Object, download?: boolean) => Promise<void>;
}) {
  const visibleKeys = objects.map((object) => object.key);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="checkbox-cell">
              <input
                type="checkbox"
                aria-label="Select all files on this page"
                checked={visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key))}
                ref={(node) => {
                  if (node)
                    node.indeterminate =
                      visibleKeys.some((key) => selected.has(key)) &&
                      !visibleKeys.every((key) => selected.has(key));
                }}
                disabled={!visibleKeys.length}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const key of visibleKeys) {
                      if (event.target.checked) next.add(key);
                      else next.delete(key);
                    }
                    return next;
                  })
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
                  type="button"
                  className="object-name"
                  onClick={() =>
                    navigate(bucket, parts.slice(0, -1).join("/") + (parts.length > 1 ? "/" : ""))
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
          {folders.map((key) => (
            <tr key={key}>
              <td />
              <td>
                <button type="button" className="object-name" onClick={() => navigate(bucket, key)}>
                  <span className="file-icon folder">
                    <Folder size={19} />
                  </span>
                  <span>{key.slice(prefix.length).replace(/\/$/, "") || "(empty segment)"}</span>
                  <ChevronRight size={13} className="folder-arrow" />
                </button>
              </td>
              <td className="muted">Folder</td>
              <td>—</td>
              <td>
                <div className="row-actions">
                  <button
                    type="button"
                    className="icon-button delete-action"
                    title={`Delete folder and contents ${key}`}
                    onClick={() =>
                      setModal({
                        type: "folder-delete",
                        prefix: key,
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {objects.map((object) => (
            <tr key={object.key} className={selected.has(object.key) ? "selected" : ""}>
              <td className="checkbox-cell">
                <input
                  type="checkbox"
                  aria-label={`Select ${object.key}`}
                  checked={selected.has(object.key)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(object.key)) next.delete(object.key);
                      else next.add(object.key);
                      return next;
                    })
                  }
                />
              </td>
              <td>
                <button
                  type="button"
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
              <td className="date-cell">{date(object.last_modified)}</td>
              <td>
                <div className="row-actions">
                  <button
                    type="button"
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
                    type="button"
                    className="icon-button"
                    title="Copy presigned URL"
                    onClick={() => void signed(object)}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Download through backend"
                    onClick={() => void signed(object, true)}
                  >
                    <ArrowDownToLine size={15} />
                  </button>
                  <button
                    type="button"
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
                    type="button"
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
          title={filter ? "No matching objects" : "A little room for something new"}
          text={
            filter
              ? "Try another search. Search applies to this page."
              : "Drop files here or use Upload files to get started."
          }
        />
      )}
    </div>
  );
}
