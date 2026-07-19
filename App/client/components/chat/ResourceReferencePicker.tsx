import React from "react";
import { Link2 } from "lucide-react";
import { api, CompanySearchResult, SearchResultKind } from "../../lib/api";

/**
 * A company resource selected from the chat composer. The company-wide search
 * endpoint already applies the signed-in Member's visibility rules, so every
 * chat surface can share this picker without growing a second resource
 * directory with subtly different access checks.
 */
export type ChatResourceReference = CompanySearchResult;

const KIND_LABELS: Record<SearchResultKind, string> = {
  employee: "AI employee",
  skill: "Skill",
  routine: "Routine",
  channel: "Channel",
  project: "Project",
  todo: "Todo",
  base: "Base",
  notebook: "Notebook",
  note: "Note",
  resource: "Resource",
  chart: "Chart",
  dashboard: "Dashboard",
  repo: "Code repository",
  pipeline: "Pipeline",
  customer: "Customer",
};

/** Resource searches start at two characters, matching the search endpoint. */
const SEARCH_DELAY_MS = 160;

export function useResourceReferences(
  companyId: string,
  query: string | null,
): { references: ChatResourceReference[]; loading: boolean } {
  const [references, setReferences] = React.useState<ChatResourceReference[]>([]);
  const [loading, setLoading] = React.useState(false);
  const latestRef = React.useRef("");

  React.useEffect(() => {
    const q = query?.trim() ?? "";
    const key = `${companyId}\u0000${q}`;
    latestRef.current = key;
    if (q.length < 2) {
      setReferences([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .get<{ results: CompanySearchResult[] }>(
          `/api/companies/${companyId}/search?q=${encodeURIComponent(q)}`,
        )
        .then(({ results }) => {
          if (latestRef.current !== key) return;
          // People use @mentions. The # picker is for the company resources
          // the employee should inspect or act on.
          setReferences(results.filter((result) => result.kind !== "employee"));
          setLoading(false);
        })
        .catch(() => {
          if (latestRef.current !== key) return;
          setReferences([]);
          setLoading(false);
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [companyId, query]);

  return { references, loading };
}

/**
 * Find the active `#query` immediately before the caret. Spaces are allowed so
 * `#quarterly plan` searches the same way as the global palette. A selected
 * reference becomes a Markdown link, whose `#` lives inside `[...]`; that
 * means it cannot accidentally reopen the picker on the following keystroke.
 */
export function resourceQueryAtCaret(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const match = /(^|[\s(])#([^#\n]{0,120})$/.exec(before);
  if (!match) return null;
  const start = before.length - match[2].length - 1;
  return { query: match[2], start };
}

/** Insert a readable, clickable resource tag while preserving the tail. */
export function insertResourceReference(args: {
  value: string;
  caret: number;
  start: number;
  companySlug: string;
  reference: ChatResourceReference;
}): { value: string; caret: number } {
  const label = args.reference.label.startsWith("#")
    ? args.reference.label
    : `#${args.reference.label}`;
  const safeLabel = label.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  const tag = `[${safeLabel}](/c/${args.companySlug}${args.reference.path})`;
  const before = args.value.slice(0, args.start);
  const after = args.value.slice(args.caret);
  const separator = after.startsWith(" ") ? "" : " ";
  const next = `${before}${tag}${separator}${after}`;
  return { value: next, caret: before.length + tag.length + separator.length };
}

export function ResourceReferencePicker({
  references,
  loading,
  activeIndex,
  onHover,
  onPick,
  className = "",
}: {
  references: ChatResourceReference[];
  loading: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (reference: ChatResourceReference) => void;
  className?: string;
}) {
  if (!loading && references.length === 0) return null;

  return (
    <div
      className={
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 " +
        className
      }
      role="listbox"
      aria-label="Company resources"
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Company resources
      </div>
      {loading && references.length === 0 ? (
        <div className="px-3 pb-2 text-xs text-slate-400 dark:text-slate-500">Searching…</div>
      ) : (
        <div className="max-h-72 overflow-y-auto pb-1">
          {references.map((reference, index) => (
            <button
              type="button"
              key={`${reference.kind}-${reference.id}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(reference);
              }}
              onMouseEnter={() => onHover(index)}
              className={
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-left " +
                (index === activeIndex
                  ? "bg-indigo-50 dark:bg-indigo-500/10"
                  : "hover:bg-slate-50 dark:hover:bg-slate-800")
              }
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                <Link2 size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {reference.label}
                </span>
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  {KIND_LABELS[reference.kind]}
                  {reference.sublabel ? ` · ${reference.sublabel}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
