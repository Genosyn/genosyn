import React from "react";
import { Archive, ArchiveRestore, X } from "lucide-react";
import { Button } from "../ui/Button";
import type { ArchiveAction } from "./useArchiveSelection";

/**
 * The pieces every archivable Finance list and detail page shares —
 * Estimates, Invoices, and Recurring invoices — so filing a record away looks
 * and works the same on each.
 */

/** One status tab above a Finance list, with its count once the list has loaded. */
export function FilterTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: React.ReactNode;
  count: number | null;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-md px-3 py-1.5 text-xs font-medium transition " +
        (active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800")
      }
    >
      {label}
      {count !== null && (
        <span className="ml-1.5 text-[10px] tabular-nums text-slate-400">{count}</span>
      )}
    </button>
  );
}

/**
 * Beside an archived row's number where a list mixes archived rows in — the
 * invoices behind a figure that counts filed ones, such as cash received.
 */
export function ArchivedTag() {
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-slate-100 px-1 py-0.5 align-middle font-sans text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <Archive size={10} aria-hidden="true" /> Archived
    </span>
  );
}

/** The Archived tab's label. */
export function ArchivedTabLabel() {
  return (
    <span className="inline-flex items-center gap-1">
      <Archive size={12} /> Archived
    </span>
  );
}

/**
 * Floating bar for a selection. One verb — Archive, or Restore in the
 * Archived view; voiding, ending and deleting stay on each record, where they
 * can't sweep up a hundred rows by accident.
 */
export function ArchiveBulkBar({
  count,
  action,
  busy,
  onRun,
  onClear,
}: {
  count: number;
  action: ArchiveAction;
  busy: ArchiveAction | null;
  onRun: () => void;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <span className="px-1 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
          {count} selected
        </span>
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <Button size="sm" variant="ghost" loading={busy === action} onClick={onRun}>
          {action === "archive" ? (
            <>
              <Archive size={14} /> Archive
            </>
          ) : (
            <>
              <ArchiveRestore size={14} /> Restore
            </>
          )}
        </Button>
        <button
          onClick={onClear}
          disabled={busy !== null}
          aria-label="Clear selection"
          className="ml-1 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** Beside a detail page's status badge while the record is archived. */
export function ArchivedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:bg-slate-700/40 dark:text-slate-300">
      <Archive size={10} /> Archived
    </span>
  );
}

/**
 * A detail page's note that the record is archived, with Restore for a
 * Member who may change finances. `children` says where it is listed now and
 * what archiving left as it was.
 */
export function ArchivedBanner({
  children,
  onRestore,
  restoring,
  disabled,
}: {
  children: React.ReactNode;
  /** Omitted for a read-only Member. */
  onRestore?: () => void;
  restoring: boolean;
  disabled: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-700 dark:bg-slate-800/40">
      <div className="flex min-w-[16rem] flex-1 items-start gap-2 text-slate-600 dark:text-slate-300">
        <Archive size={15} className="mt-0.5 shrink-0 text-slate-400" />
        <span>{children}</span>
      </div>
      {onRestore && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRestore}
          loading={restoring}
          disabled={disabled}
        >
          <ArchiveRestore size={14} /> Restore
        </Button>
      )}
    </div>
  );
}
