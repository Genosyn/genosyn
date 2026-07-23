import React from "react";

/**
 * Paste- and drop-to-attach helpers shared by every message composer
 * (employee chat, workspace chat, mail reply/compose). Each composer already
 * owns an upload pipeline behind its paperclip button; these helpers feed the
 * same pipeline from a pasted screenshot or a dragged-in file so the human
 * doesn't have to save-then-pick.
 */

/**
 * Pull `File` objects out of a paste's `clipboardData` or a drop's
 * `dataTransfer`. Prefers `items` — a screenshot pasted from the OS lands
 * there as a `kind: "file"` entry and doesn't always populate `.files` — and
 * falls back to `.files` for browsers that only expose the file list.
 */
export function filesFromDataTransfer(
  dt: DataTransfer | null | undefined,
): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  // Only fall back when `items` yielded nothing — otherwise a single file can
  // show up in both collections and get uploaded twice.
  if (out.length === 0 && dt.files && dt.files.length > 0) {
    out.push(...Array.from(dt.files));
  }
  return out;
}

/**
 * Files a paste should turn into attachments rather than inserting as text.
 * A pasted screenshot or copied image carries no `text/plain`, so a non-empty
 * text payload (spreadsheet cells, for instance, always ship text alongside a
 * bitmap) is left to the browser's default text paste and yields nothing here.
 */
export function pastedUploadFiles(
  dt: DataTransfer | null | undefined,
): File[] {
  if (!dt) return [];
  const text = dt.getData("text/plain");
  if (text && text.trim().length > 0) return [];
  return filesFromDataTransfer(dt);
}

/**
 * Whether an in-progress drag carries files. During `dragover` the file list
 * isn't readable yet, so we sniff `types` — the one signal available before
 * the drop — to decide whether to accept the drag at all.
 */
export function dataTransferHasFiles(
  dt: DataTransfer | null | undefined,
): boolean {
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).includes("Files")) return true;
  return !!(dt.files && dt.files.length > 0);
}

/**
 * Wire a composer up for paste- and drag-to-attach. Returns an `onPaste`
 * handler for the textarea, a `dragProps` bundle for the surrounding drop
 * zone, and a `dragActive` flag the zone can use to highlight itself. The
 * caller supplies a single `onFiles` sink — its own upload function.
 */
export function useComposerFileDrop(onFiles: (files: File[]) => void): {
  dragActive: boolean;
  onPaste: (e: React.ClipboardEvent) => void;
  dragProps: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [dragActive, setDragActive] = React.useState(false);

  const onPaste = React.useCallback(
    (e: React.ClipboardEvent) => {
      const files = pastedUploadFiles(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      onFiles(files);
    },
    [onFiles],
  );

  const onDragOver = React.useCallback((e: React.DragEvent) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    // Announce we'll accept the drop; without this the browser rejects it.
    e.preventDefault();
    setDragActive(true);
  }, []);

  const onDragLeave = React.useCallback((e: React.DragEvent) => {
    // Ignore leaves that only cross into a child element — the drag is still
    // inside the zone, so keep the highlight on.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      if (!dataTransferHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragActive(false);
      const files = filesFromDataTransfer(e.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return {
    dragActive,
    onPaste,
    dragProps: { onDragOver, onDragLeave, onDrop },
  };
}
