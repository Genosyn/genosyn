import React from "react";
import { Search } from "lucide-react";
import { useLocation } from "react-router-dom";
import type { Approval, Decision } from "@/lib/api";

/**
 * What the Decision stack's two pages share: the active stack and its History.
 *
 * Every notification, chat transcript, and Ask AI answer links an item as
 * `/decisions#decision-<id>` or `/decisions#review-<id>`. Those links keep that
 * shape; the active page sends one naming something already settled on to
 * History, so an old link still lands on its card.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LINK = new RegExp(`^#(decision|review)-(${UUID})$`, "i");

export type StackLink = { kind: "decision" | "review"; id: string };

/** The Decision or review a `#decision-<id>` / `#review-<id>` hash names. */
export function stackLinkFromHash(hash: string): StackLink | null {
  const match = LINK.exec(hash);
  if (!match) return null;
  return { kind: match[1].toLowerCase() as StackLink["kind"], id: match[2].toLowerCase() };
}

/** Only these Approval kinds belong in the stack; the rest stay at Approvals. */
export function isStackReview(approval: Approval): boolean {
  return approval.kind === "proactive_work" || approval.kind === "mail_send";
}

function mentions(query: string, text: (string | null | undefined)[]): boolean {
  return text.some((value) => value?.toLocaleLowerCase().includes(query));
}

/** `query` is already trimmed and lower-cased; empty matches everything. */
export function decisionMatches(row: Decision, query: string): boolean {
  return (
    !query ||
    mentions(query, [
      row.title,
      row.body,
      row.note,
      row.pickupSummary,
      row.employee?.name,
      row.assignee?.name,
      row.decidedBy?.name,
      row.decidedByEmployee?.name,
      row.source.mailThread?.subject,
      row.source.routine?.name,
      ...row.options.flatMap((option) => [option.label, option.detail]),
    ])
  );
}

/** `query` is already trimmed and lower-cased; empty matches everything. */
export function reviewMatches(row: Approval, query: string): boolean {
  return (
    !query ||
    mentions(query, [
      row.title,
      row.summary,
      row.outcomeSummary,
      row.employee?.name,
      row.review?.kind === "work" ? row.review.context : null,
      row.review?.kind === "work" ? row.review.plan : null,
      row.review?.kind === "mail" ? row.review.context : null,
      row.review?.kind === "mail" ? row.review.workSummary : null,
      row.review?.kind === "mail" ? row.review.draft.subject : null,
      row.review?.kind === "mail" ? row.review.draft.bodyText : null,
    ])
  );
}

/**
 * Bring a linked card into view once per navigation, whenever its rows first
 * render. Later live refreshes must not keep pulling the reader back to it.
 */
export function useScrollToStackLink(): void {
  const location = useLocation();
  const scrolledTo = React.useRef<string | null>(null);
  React.useEffect(() => {
    const link = stackLinkFromHash(location.hash);
    if (!link) return;
    const key = `${location.key}:${location.hash}`;
    if (scrolledTo.current === key) return;
    const target = document.getElementById(`${link.kind}-${link.id}`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    scrolledTo.current = key;
  });
}

export function StackSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 basis-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 sm:basis-0 dark:border-slate-700 dark:bg-slate-900">
      <Search size={16} className="shrink-0 text-slate-400" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
      />
    </label>
  );
}

export function StackSection({
  title,
  aside,
  children,
}: {
  title: string;
  /** Badges and controls drawn on the heading's row. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
