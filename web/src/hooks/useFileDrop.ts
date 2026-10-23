import { useEffect, useRef, useState } from "react";

/** Drag-and-drop enhances the accessible file input; presentation has no fake button semantics. */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const callback = useRef(onFiles);
  callback.current = onFiles;
  useEffect(() => {
    if (!enabled) {
      setDragging(false);
      return;
    }
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(false);
      callback.current(Array.from(event.dataTransfer.files));
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDragging(false);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("keydown", dismiss);
    };
  }, [enabled]);
  return dragging;
}
