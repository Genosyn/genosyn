import React from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileImage,
  FilePlus2,
  FileX2,
  MoveRight,
} from "lucide-react";
import { clsx } from "../ui/clsx";
import { DiffFile, DiffLine, parseDiff } from "./parseDiff";

/**
 * Unified-diff renderer for anything the repository API returns a patch for:
 * the working tree, a commit, an AI Employee's branch.
 *
 * Long source lines are the whole design problem here. They must scroll
 * sideways inside the diff and never widen the page, so each file body owns an
 * `overflow-x-auto` box and the rows inside it are `w-max min-w-full` — wide
 * enough for the longest line, but never narrower than the box, so the
 * add/remove tints still reach the right edge on short lines.
 */

const STATUS_META: Record<
  DiffFile["status"],
  { label: string; icon: React.ReactNode; className: string }
> = {
  added: {
    label: "Added",
    icon: <FilePlus2 size={13} />,
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  deleted: {
    label: "Deleted",
    icon: <FileX2 size={13} />,
    className: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  },
  renamed: {
    label: "Renamed",
    icon: <MoveRight size={13} />,
    className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  modified: {
    label: "Modified",
    icon: <FileDiff size={13} />,
    className: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  },
};

export function DiffView({
  patch,
  truncated = false,
  emptyMessage = "No changes.",
  className,
}: {
  patch: string;
  /** The server capped the patch — say so rather than showing a clipped diff. */
  truncated?: boolean;
  emptyMessage?: string;
  className?: string;
}) {
  const files = React.useMemo(() => parseDiff(patch), [patch]);

  if (files.length === 0) {
    return (
      <div
        className={clsx(
          "rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400",
          className,
        )}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={clsx("flex flex-col gap-3", className)}>
      {files.map((file, index) => (
        <DiffFileBlock key={`${file.path}-${index}`} file={file} />
      ))}
      {truncated && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            This diff was too large to send in full and stops here. Open the repository in a git
            client, or narrow the change, to see the rest.
          </span>
        </div>
      )}
    </div>
  );
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  const [open, setOpen] = React.useState(true);
  const meta = STATUS_META[file.status];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-slate-400" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-slate-400" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700 dark:text-slate-200">
          {file.status === "renamed" && file.oldPath ? (
            <>
              <span className="text-slate-400 dark:text-slate-500">{file.oldPath}</span>
              <span className="px-1 text-slate-400">→</span>
              {file.newPath}
            </>
          ) : (
            file.path
          )}
        </span>
        <span
          className={clsx(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            meta.className,
          )}
        >
          {meta.icon} {meta.label}
        </span>
        {!file.binary && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span>
          </span>
        )}
      </button>

      {open &&
        (file.binary ? (
          <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <FileImage size={14} className="shrink-0" />
            Binary file — nothing to show as text.
          </div>
        ) : file.hunks.length === 0 ? (
          <div className="border-t border-slate-100 px-4 py-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            No line changes — only the file&apos;s path or mode moved.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-slate-100 dark:border-slate-800">
            <div className="w-max min-w-full font-mono text-xs leading-5">
              {file.hunks.map((hunk, index) => (
                <React.Fragment key={`${hunk.header}-${index}`}>
                  <div className="flex bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <span className="w-24 shrink-0 select-none border-r border-slate-200 px-2 dark:border-slate-700">
                      @@
                    </span>
                    <span className="whitespace-pre px-3">
                      {hunk.header.replace(/^@@ /, "").replace(/ @@.*$/, " @@")}
                      {hunk.heading ? `  ${hunk.heading}` : ""}
                    </span>
                  </div>
                  {hunk.lines.map((line, lineIndex) => (
                    <DiffRow key={lineIndex} line={line} />
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.type === "meta") {
    return (
      <div className="flex text-slate-400 dark:text-slate-500">
        <span className="w-24 shrink-0 select-none border-r border-slate-100 dark:border-slate-800" />
        <span className="whitespace-pre px-3 italic">{line.content}</span>
      </div>
    );
  }

  const tone =
    line.type === "add"
      ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200"
      : line.type === "remove"
        ? "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200"
        : "text-slate-600 dark:text-slate-300";

  return (
    <div className={clsx("flex", tone)}>
      <span className="flex w-24 shrink-0 select-none border-r border-slate-100 text-[11px] tabular-nums text-slate-400 dark:border-slate-800 dark:text-slate-500">
        <span className="w-1/2 px-2 text-right">{line.oldNumber ?? ""}</span>
        <span className="w-1/2 px-2 text-right">{line.newNumber ?? ""}</span>
      </span>
      <span className="w-4 shrink-0 select-none text-center opacity-70">
        {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
      </span>
      <span className="whitespace-pre pr-4">{line.content}</span>
    </div>
  );
}

/** The "+12 −3 across 4 files" line every diff surface puts above the view. */
export function DiffStats({
  filesChanged,
  insertions,
  deletions,
  className,
}: {
  filesChanged: number;
  insertions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400",
        className,
      )}
    >
      <span>
        {filesChanged} {filesChanged === 1 ? "file" : "files"}
      </span>
      <span className="text-emerald-600 dark:text-emerald-400">+{insertions}</span>
      <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
    </span>
  );
}
