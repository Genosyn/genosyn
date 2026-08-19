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
import { TokenKind, highlight, languageForPath } from "./highlight";

/**
 * Unified-diff renderer for anything the repository API returns a patch for:
 * the working tree, a commit, an AI Employee's branch.
 *
 * ## Collapsed by default, and why
 *
 * This used to render every file expanded. On a change touching thirty files
 * that is tens of thousands of DOM rows the reader did not ask for, and the
 * only way to find the one file they cared about was to scroll past all the
 * others. A review surface's first job is to tell you the *shape* of a change
 * — how many files, how big, which ones — and its second is to let you open
 * the part you want. So the summary comes first and the bodies are opened on
 * demand, which is the shape every tool people already use has settled on.
 *
 * Small changes still open themselves ({@link shouldAutoExpand}): collapsing a
 * two-line fix behind a click is ceremony, not restraint.
 *
 * ## Long lines
 *
 * They must scroll sideways inside the diff and never widen the page, so each
 * file body owns an `overflow-x-auto` box and the rows inside it are
 * `w-max min-w-full` — wide enough for the longest line, but never narrower
 * than the box, so the add/remove tints still reach the right edge on short
 * lines.
 */

const STATUS_META: Record<
  DiffFile["status"],
  { label: string; icon: React.ReactNode; className: string; dot: string }
> = {
  added: {
    label: "Added",
    icon: <FilePlus2 size={13} />,
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  deleted: {
    label: "Deleted",
    icon: <FileX2 size={13} />,
    className: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  renamed: {
    label: "Renamed",
    icon: <MoveRight size={13} />,
    className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
    dot: "bg-indigo-500",
  },
  modified: {
    label: "Modified",
    icon: <FileDiff size={13} />,
    className: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    dot: "bg-slate-400 dark:bg-slate-500",
  },
};

/**
 * A change small enough that hiding it behind a click is just an extra click.
 * Tuned to "a fix", not "a feature": one or two files, and little enough that
 * the whole thing is on screen at once.
 */
function shouldAutoExpand(files: DiffFile[]): boolean {
  if (files.length === 0 || files.length > 2) return false;
  const lines = files.reduce((total, file) => total + file.additions + file.deletions, 0);
  return lines <= 120;
}

/**
 * Past this, a file opens without syntax colour. Tokenizing is linear and
 * cheap per line, but a generated lockfile is tens of thousands of lines and
 * responsiveness beats prettiness on exactly the files nobody reads closely.
 */
const MAX_HIGHLIGHT_LINES = 1500;

export function DiffView({
  patch,
  truncated = false,
  emptyMessage = "No changes.",
  className,
  filesChanged,
  /**
   * Force every file open, for surfaces showing a single file's diff where the
   * summary would be a header over one row.
   */
  expanded,
}: {
  patch: string;
  /** The server capped the patch — say so rather than showing a clipped diff. */
  truncated?: boolean;
  emptyMessage?: string;
  className?: string;
  /**
   * The server's own file count. It is counted over the whole diff while the
   * patch body is capped, so on a truncated change it is larger than anything
   * parsed here — which is the only number that can honestly say "showing 101
   * of 214".
   */
  filesChanged?: number;
  expanded?: boolean;
}) {
  const files = React.useMemo(() => parseDiff(patch), [patch]);

  // Keyed by path so the set survives a re-parse: a diff that reloads because
  // the branch moved should not slam shut every file the reader had open.
  const [openPaths, setOpenPaths] = React.useState<Set<string> | null>(null);

  const autoOpen = React.useMemo(
    () => (expanded ?? shouldAutoExpand(files) ? new Set(files.map((file) => file.path)) : new Set<string>()),
    [files, expanded],
  );
  const open = openPaths ?? autoOpen;

  function toggle(path: string) {
    setOpenPaths((current) => {
      const next = new Set(current ?? autoOpen);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

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

  // Counted over the files actually on screen, not over the set: a diff that
  // reloaded smaller leaves paths behind in `openPaths`, and comparing sizes
  // would then call it "all open" with files still shut.
  const allOpen = files.every((file) => open.has(file.path));
  const hidden = truncated && filesChanged && filesChanged > files.length ? filesChanged : null;

  return (
    <div className={clsx("flex flex-col gap-2", className)}>
      {/* Deliberately not a second "N files changed +A −B" line. Every surface
        that renders this already prints those totals immediately above, from
        the server's own count, and stacking two near-identical summaries is
        the noise this rewrite exists to remove. What is genuinely missing up
        there is the control, and the caveat when the patch was capped. */}
      {expanded === undefined && files.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
          {hidden && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Showing {files.length} of {hidden} files
            </span>
          )}
          <button
            type="button"
            onClick={() =>
              setOpenPaths(allOpen ? new Set() : new Set(files.map((file) => file.path)))
            }
            className="ml-auto rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}

      {/* One card with divided rows, not one card per file: thirty collapsed
        files as thirty bordered cards with gaps between them is the same wall
        of chrome in a different shape. */}
      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {files.map((file, index) => (
          <DiffFileBlock
            key={`${file.path}-${index}`}
            file={file}
            open={open.has(file.path)}
            onToggle={() => toggle(file.path)}
          />
        ))}
      </div>

      {truncated && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {/* This surface is read by whoever owns the document, not only by
              people with a terminal — telling them to install a git client is
              telling them the product cannot help. */}
            This change is too big to show all of it here. The rest is safely stored — open the
            individual files to read them.
          </span>
        </div>
      )}
    </div>
  );
}

function DiffFileBlock({
  file,
  open,
  onToggle,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
}) {
  const meta = STATUS_META[file.status];
  const language = React.useMemo(() => languageForPath(file.path), [file.path]);
  const lineCount = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  const colour = open && !file.binary && lineCount <= MAX_HIGHLIGHT_LINES ? language : null;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60",
          open && "border-b border-slate-100 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-800/40",
        )}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-slate-400" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-slate-400" />
        )}
        <FilePath file={file} />
        <span
          className={clsx(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            meta.className,
          )}
        >
          {meta.icon} {meta.label}
        </span>
        {!file.binary && (
          <>
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
              <span className="text-rose-600 dark:text-rose-400">&minus;{file.deletions}</span>
            </span>
            <ChangeBar additions={file.additions} deletions={file.deletions} />
          </>
        )}
      </button>

      {open &&
        (file.binary ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-slate-500 dark:text-slate-400">
            <FileImage size={14} className="shrink-0" />
            Binary file — nothing to show as text.
          </div>
        ) : file.hunks.length === 0 ? (
          <div className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">
            No line changes — only the file&apos;s path or mode moved.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="w-max min-w-full font-mono text-xs leading-5">
              {file.hunks.map((hunk, index) => (
                <React.Fragment key={`${hunk.header}-${index}`}>
                  <div className="flex bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <span className="w-14 shrink-0 select-none border-r border-slate-200 px-2 dark:border-slate-700 sm:w-24">
                      @@
                    </span>
                    <span className="whitespace-pre px-3">
                      {hunk.header.replace(/^@@ /, "").replace(/ @@.*$/, " @@")}
                      {hunk.heading ? `  ${hunk.heading}` : ""}
                    </span>
                  </div>
                  {hunk.lines.map((line, lineIndex) => (
                    <DiffRow key={lineIndex} line={line} language={colour} />
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

/**
 * `src/server/services/` in grey, `repositories.ts` in ink.
 *
 * A column of full paths is a column of near-identical prefixes, and the eye
 * has to read to the end of every one to tell them apart. Dimming the
 * directory puts the part that differs first in the visual order without
 * hiding where the file lives.
 */
function FilePath({ file }: { file: DiffFile }) {
  if (file.status === "renamed" && file.oldPath) {
    return (
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700 dark:text-slate-200">
        <span className="text-slate-400 dark:text-slate-500">{file.oldPath}</span>
        <span className="px-1 text-slate-400">→</span>
        {file.newPath}
      </span>
    );
  }
  const cut = file.path.lastIndexOf("/");
  const directory = cut < 0 ? "" : file.path.slice(0, cut + 1);
  const name = cut < 0 ? file.path : file.path.slice(cut + 1);
  return (
    <span
      className="min-w-0 flex-1 truncate text-left font-mono text-xs text-slate-900 dark:text-slate-100"
      title={file.path}
    >
      {directory && <span className="text-slate-400 dark:text-slate-500">{directory}</span>}
      {name}
    </span>
  );
}

/** GitHub's five squares: the size and direction of a change, pre-attentively. */
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  // Each side that changed anything is guaranteed at least one square, so the
  // other side is capped to leave room for it — otherwise rounding hands out a
  // sixth square whenever one side dominates.
  const green = Math.min(
    5 - (deletions > 0 ? 1 : 0),
    Math.max(additions > 0 ? 1 : 0, Math.round((additions / total) * 5)),
  );
  const red = Math.max(
    deletions > 0 ? 1 : 0,
    Math.min(5 - green, Math.round((deletions / total) * 5)),
  );
  const grey = Math.max(0, 5 - green - red);
  return (
    <span className="hidden shrink-0 items-center gap-px sm:flex" aria-hidden>
      {Array.from({ length: green }, (_, index) => (
        <span key={`a${index}`} className="h-2 w-2 rounded-[2px] bg-emerald-500" />
      ))}
      {Array.from({ length: red }, (_, index) => (
        <span key={`d${index}`} className="h-2 w-2 rounded-[2px] bg-rose-500" />
      ))}
      {Array.from({ length: grey }, (_, index) => (
        <span key={`n${index}`} className="h-2 w-2 rounded-[2px] bg-slate-200 dark:bg-slate-700" />
      ))}
    </span>
  );
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "",
  keyword: "text-violet-700 dark:text-violet-300",
  string: "text-emerald-700 dark:text-emerald-400",
  comment: "text-slate-400 dark:text-slate-500",
  number: "text-amber-700 dark:text-amber-400",
  tag: "text-rose-700 dark:text-rose-400",
  attr: "text-sky-700 dark:text-sky-300",
  punctuation: "text-slate-400 dark:text-slate-500",
};

function DiffRow({ line, language }: { line: DiffLine; language: string | null }) {
  if (line.type === "meta") {
    return (
      <div className="flex text-slate-400 dark:text-slate-500">
        <span className="w-14 shrink-0 select-none border-r border-slate-100 dark:border-slate-800 sm:w-24" />
        <span className="whitespace-pre px-3 italic">{line.content}</span>
      </div>
    );
  }

  const tone =
    line.type === "add"
      ? "bg-emerald-50/70 dark:bg-emerald-500/10"
      : line.type === "remove"
        ? "bg-rose-50/70 dark:bg-rose-500/10"
        : "";

  return (
    <div className={clsx("flex", tone)}>
      <span className="flex w-14 shrink-0 select-none border-r border-slate-100 text-[11px] tabular-nums text-slate-400 dark:border-slate-800 dark:text-slate-500 sm:w-24">
        <span className="w-1/2 px-2 text-right">{line.oldNumber ?? ""}</span>
        <span className="w-1/2 px-2 text-right">{line.newNumber ?? ""}</span>
      </span>
      <span
        className={clsx(
          "w-4 shrink-0 select-none text-center",
          line.type === "add"
            ? "text-emerald-600 dark:text-emerald-400"
            : line.type === "remove"
              ? "text-rose-600 dark:text-rose-400"
              : "text-slate-300 dark:text-slate-600",
        )}
      >
        {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
      </span>
      <span className="whitespace-pre pr-4 text-slate-700 dark:text-slate-200">
        {language ? <HighlightedLine source={line.content} language={language} /> : line.content}
      </span>
    </div>
  );
}

/**
 * One diff line, coloured.
 *
 * Tokenized per line rather than per file, because a diff has no whole file to
 * tokenize — the hunks between are missing. The cost is that a construct
 * spanning lines (a block comment, a template literal) loses its colour after
 * the first line. That is the same trade every diff view of this shape makes,
 * and it is worth it: the alternative is no colour at all.
 */
function HighlightedLine({ source, language }: { source: string; language: string }) {
  const tokens = React.useMemo(() => highlight(source, language), [source, language]);
  return (
    <>
      {tokens.map((token, index) => {
        const className = TOKEN_CLASS[token.kind];
        return className ? (
          <span key={index} className={className}>
            {token.text}
          </span>
        ) : (
          <React.Fragment key={index}>{token.text}</React.Fragment>
        );
      })}
    </>
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
      <span className="text-rose-600 dark:text-rose-400">&minus;{deletions}</span>
    </span>
  );
}
