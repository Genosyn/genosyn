import React from "react";
import { Link2 } from "lucide-react";
import { api, CompanySearchResult, SearchResultKind } from "../../lib/api";
import type { ChatResourceReference } from "./resourceReferences";

export {
  insertResourceReference,
  resourceQueryAtCaret,
  type ChatResourceReference,
} from "./resourceReferences";

/**
 * A product area or company resource selected from the chat composer. The
 * company-wide search endpoint applies the signed-in Member's visibility
 * rules, so every chat surface can share this picker without growing a second
 * resource directory with subtly different access checks.
 */
const KIND_LABELS: Record<SearchResultKind, string> = {
  product: "Product area",
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
  repository: "Repository",
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
          // People use @mentions. The # picker is for product hints and the
          // company resources the employee should inspect or act on.
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
      aria-label="Product areas and company resources"
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Product areas &amp; resources
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
