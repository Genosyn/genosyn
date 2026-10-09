import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock3,
  X,
  XCircle,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import type { StatusLine, StatusTone } from "@/components/decisions/stackStatus";

/**
 * The pieces every row of the Decision stack shares, so a question, an email
 * and a work plan read alike on Home, in the stack and in History: a one-line
 * status, a single Details disclosure, and a quiet Close.
 */

const TONE_TEXT: Record<StatusTone, string> = {
  progress: "text-indigo-700 dark:text-indigo-300",
  success: "text-emerald-700 dark:text-emerald-300",
  saved: "text-slate-700 dark:text-slate-200",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-rose-700 dark:text-rose-300",
  neutral: "text-slate-700 dark:text-slate-200",
};

const QUIET_ICON =
  "bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700";

const TONE_ICON: Record<StatusTone, string> = {
  progress:
    "bg-indigo-50 text-indigo-600 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/30",
  success:
    "bg-emerald-50 text-emerald-600 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30",
  saved: QUIET_ICON,
  warning:
    "bg-amber-50 text-amber-600 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30",
  danger:
    "bg-rose-50 text-rose-600 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30",
  neutral: QUIET_ICON,
};

const TONE_MARK: Record<StatusTone, typeof CheckCircle2> = {
  progress: Clock3,
  success: CheckCircle2,
  saved: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  neutral: CircleSlash,
};

/** The round mark at the start of a settled row. */
export function StatusIcon({ status }: { status: StatusLine }) {
  const Icon = TONE_MARK[status.tone];
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1",
        TONE_ICON[status.tone],
      )}
    >
      {status.working ? <Spinner size={12} /> : <Icon size={13} />}
    </span>
  );
}

/** "Done · Registered on BidNet" — the label strong, the rest quiet. */
export function StatusText({ status, className }: { status: StatusLine; className?: string }) {
  return (
    <p
      data-status-line
      className={clsx(
        "line-clamp-2 break-words text-sm leading-snug text-slate-600 dark:text-slate-300",
        className,
      )}
    >
      <span className={clsx("font-medium", TONE_TEXT[status.tone])}>{status.label}</span>
      {status.text && (
        <>
          <span className="text-slate-400 dark:text-slate-500"> · </span>
          {status.text}
        </>
      )}
    </p>
  );
}

/**
 * The one disclosure a row has: everything beyond its first lines. `xs` sits
 * in a row's header line; `sm` beside other row actions.
 */
export function DetailsButton({
  open,
  controls,
  onToggle,
  disabled = false,
  size = "sm",
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  disabled?: boolean;
  size?: "xs" | "sm";
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      aria-controls={controls}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-lg font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 disabled:opacity-60 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
        size === "xs" ? "-my-1 h-7 px-1.5 text-xs" : "h-8 px-2 text-sm",
      )}
    >
      {open ? (
        <ChevronUp size={size === "xs" ? 13 : 14} />
      ) : (
        <ChevronDown size={size === "xs" ? 13 : 14} />
      )}
      {open ? "Hide details" : "Details"}
    </button>
  );
}

/** Takes a settled row off the active stack; its story stays in History. */
export function CloseRowButton({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      title="Close"
      className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <X size={15} />
    </button>
  );
}

/** A labelled part of a row's Details. */
export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h4>
      <div className="mt-1.5 min-w-0 break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200">
        {children}
      </div>
    </section>
  );
}

/** The box a row's Details open in. */
export function DetailsPanel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div
      id={id}
      className="mt-3 space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-800/40"
    >
      {children}
    </div>
  );
}

/**
 * When a row is about to leave the list — dismissed, discarded, declined —
 * note where keyboard focus should land, and return a function that puts it
 * there once the row is gone: the next row, else the one before, else the
 * list's section heading.
 */
export function focusAfterRemoval(row: HTMLElement | null): () => void {
  if (!row || typeof document === "undefined") return () => {};
  const list = row.closest<HTMLElement>("[data-stack-list]");
  const rows = list ? Array.from(list.querySelectorAll<HTMLElement>("[data-stack-row]")) : [];
  const index = rows.indexOf(row);
  const ids = (index < 0 ? [] : [...rows.slice(index + 1), ...rows.slice(0, index).reverse()])
    .map((element) => element.id)
    .filter(Boolean);
  const heading = list?.closest("section")?.querySelector<HTMLElement>("h2") ?? null;
  return () => {
    window.requestAnimationFrame(() => {
      if (row.isConnected && row.contains(document.activeElement)) {
        // The row is still here (the request failed): leave focus alone.
        return;
      }
      for (const id of ids) {
        const target = document.getElementById(id)?.querySelector<HTMLElement>("[data-row-focus]");
        if (target) {
          target.focus();
          return;
        }
      }
      if (heading?.isConnected) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
        return;
      }
      // The section went with its last row (Home hides an empty Active
      // decisions): land on the main region, as a closing modal does, rather
      // than leaving focus on <body>, where the next Tab starts over.
      const active = document.activeElement;
      if (!active || active === document.body) {
        document.getElementById("main-content")?.focus({ preventScroll: true });
      }
    });
  };
}
