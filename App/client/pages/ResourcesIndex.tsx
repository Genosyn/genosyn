import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardPaste,
  Clock,
  FileText,
  Globe,
  Layers,
  Library,
  Loader2,
  LayoutGrid,
  List,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  User,
  Video,
  X,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { Spinner } from "../components/ui/Spinner";
import { api, Company, CompanyTag, Resource, ResourceSourceKind } from "../lib/api";
import { TagChips, TagFilterBar, TagPicker } from "../components/TagPicker";

/**
 * Resources — knowledge ingestion. Humans paste a URL, paste raw text,
 * or upload a file (PDF / EPUB / TXT / MD / HTML / video). The server
 * extracts plain text and stores it on the row; AI employees query the
 * result via MCP tools.
 *
 * The index is a searchable library: a quiet stats strip up top, filters
 * by type and tag, sort + list/grid view (both persisted), and a card
 * grid or dense list of every entry. There's still no folder tree or
 * embeddings — grouping/vectorising waits for a later milestone once we
 * know what teams actually feed in.
 */
export default function ResourcesIndex({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [items, setItems] = React.useState<Resource[] | null>(null);
  const [showNew, setShowNew] = React.useState(false);
  const [tab, setTab] = React.useState<NewResourceTab>("url");
  const [query, setQuery] = React.useState("");
  const [selectedTagId, setSelectedTagId] = React.useState<string | null>(null);
  const [selectedKind, setSelectedKind] = React.useState<ResourceSourceKind | null>(null);
  const [failedOnly, setFailedOnly] = React.useState(false);
  const [sort, setSort] = React.useState<SortKey>(() => readPref("sort", SORT_KEYS, "updated"));
  const [view, setView] = React.useState<ViewMode>(() => readPref("view", VIEW_MODES, "grid"));
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => writePref("sort", sort), [sort]);
  React.useEffect(() => writePref("view", view), [view]);

  const reload = React.useCallback(async () => {
    try {
      const rows = await api.get<Resource[]>(
        `/api/companies/${company.id}/resources`,
      );
      setItems(rows);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load resources",
        "error",
      );
      setItems([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Press "/" anywhere to jump to search — skip when the user is already
  // typing into a field so it doesn't hijack real input.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openNew(initial: NewResourceTab) {
    setTab(initial);
    setShowNew(true);
  }

  const filtered = React.useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    const matched = items.filter((r) => {
      if (failedOnly && r.status !== "failed") return false;
      if (selectedKind && r.sourceKind !== selectedKind) return false;
      if (selectedTagId && !r.tags.some((tag) => tag.id === selectedTagId)) return false;
      if (!q) return true;
      const hay =
        r.title.toLowerCase() +
        " " +
        (r.summary ?? "").toLowerCase() +
        " " +
        (r.sourceUrl ?? "").toLowerCase() +
        " " +
        r.tags
          .map((tag) => tag.name)
          .join(" ")
          .toLowerCase();
      return hay.includes(q);
    });
    return [...matched].sort(SORTERS[sort]);
  }, [items, query, selectedTagId, selectedKind, failedOnly, sort]);

  const availableTags = React.useMemo(() => {
    const byId = new Map((items ?? []).flatMap((item) => item.tags).map((tag) => [tag.id, tag]));
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const availableKinds = React.useMemo(() => {
    const present = new Set((items ?? []).map((r) => r.sourceKind));
    return KIND_ORDER.filter((k) => present.has(k));
  }, [items]);

  const stats = React.useMemo(() => {
    const all = items ?? [];
    return {
      count: all.length,
      totalBytes: all.reduce((sum, r) => sum + Number(r.bytes || 0), 0),
      formats: new Set(all.map((r) => r.sourceKind)).size,
      tags: availableTags.length,
      failed: all.filter((r) => r.status === "failed").length,
      pending: all.filter((r) => r.status === "pending").length,
    };
  }, [items, availableTags.length]);

  const filtering =
    query.trim().length > 0 || !!selectedTagId || !!selectedKind || failedOnly;

  function clearFilters() {
    setQuery("");
    setSelectedTagId(null);
    setSelectedKind(null);
    setFailedOnly(false);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Resources" },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pt-10 pb-16 md:px-10">
          <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Resources
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                {company.name}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
                External material — articles, ebooks, transcripts — that AI
                employees can study and search later. Paste a URL, drop a file,
                or paste raw text. Each entry is searchable through the built-in
                MCP tools.
              </p>
            </div>
            {items && items.length > 0 && (
              <Button onClick={() => openNew("url")} className="shrink-0">
                <Plus size={15} /> New resource
              </Button>
            )}
          </div>

          {items && items.length > 0 && <StatsStrip stats={stats} />}

          {stats.failed > 0 && (
            <button
              type="button"
              onClick={() => setFailedOnly((v) => !v)}
              className={
                "mb-5 flex w-full items-center gap-2.5 rounded-xl border px-4 py-2.5 text-left text-sm transition " +
                (failedOnly
                  ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                  : "border-rose-200 bg-rose-50/60 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/50")
              }
            >
              <AlertTriangle size={15} className="shrink-0" />
              <span className="flex-1">
                {stats.failed} {stats.failed === 1 ? "resource" : "resources"} failed to
                ingest.
              </span>
              <span className="shrink-0 font-medium">
                {failedOnly ? "Show all" : "Review"}
              </span>
            </button>
          )}

          {items && items.length > 0 && (
            <Toolbar
              query={query}
              onQuery={setQuery}
              searchRef={searchRef}
              sort={sort}
              onSort={setSort}
              view={view}
              onView={setView}
            />
          )}

          {(availableKinds.length > 1 || availableTags.length > 0) && (
            <div className="mt-4 flex flex-col gap-2.5">
              <KindFilterBar
                kinds={availableKinds}
                selected={selectedKind}
                onSelect={setSelectedKind}
              />
              <TagFilterBar
                tags={availableTags}
                selectedId={selectedTagId}
                onSelect={setSelectedTagId}
              />
            </div>
          )}

          {items === null ? (
            <div className="mt-10 flex h-32 items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : items.length === 0 ? (
            <EmptyHero onPick={openNew} />
          ) : (
            <>
              <div className="mb-3 mt-8 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <Clock size={12} />
                  {filtering
                    ? `${filtered?.length ?? 0} of ${items.length}`
                    : `${items.length} ${items.length === 1 ? "resource" : "resources"}`}
                </div>
                {filtering && (
                  <button
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    <X size={12} /> Clear filters
                  </button>
                )}
              </div>

              {filtered && filtered.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
                  <Search size={20} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" />
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    No resources match your filters.
                  </p>
                  <button
                    onClick={clearFilters}
                    className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    Clear filters
                  </button>
                </div>
              ) : view === "grid" ? (
                <ResourceGrid company={company} items={filtered ?? []} />
              ) : (
                <ResourceList company={company} items={filtered ?? []} />
              )}
            </>
          )}
        </div>
      </div>

      <NewResourceModal
        open={showNew}
        company={company}
        initialTab={tab}
        onClose={() => setShowNew(false)}
        onCreated={(row) => {
          setShowNew(false);
          reload();
          navigate(`/c/${company.slug}/resources/${row.slug}`);
        }}
      />
    </div>
  );
}

// ─────────────────────────── Stats strip ────────────────────────────────

function StatsStrip({
  stats,
}: {
  stats: {
    count: number;
    totalBytes: number;
    formats: number;
    tags: number;
    pending: number;
  };
}) {
  const cells: { icon: React.ReactNode; label: string; value: string }[] = [
    {
      icon: <Library size={14} />,
      label: "Resources",
      value: stats.count.toLocaleString(),
    },
    {
      icon: <FileText size={14} />,
      label: "Library size",
      value: formatBytes(stats.totalBytes),
    },
    {
      icon: <Layers size={14} />,
      label: stats.pending > 0 ? "Processing" : "Formats",
      value:
        stats.pending > 0
          ? stats.pending.toLocaleString()
          : stats.formats.toLocaleString(),
    },
    {
      icon: <Sparkles size={14} />,
      label: "Tags",
      value: stats.tags.toLocaleString(),
    },
  ];
  return (
    <div className="mb-5 grid grid-cols-2 divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900 sm:grid-cols-4 sm:divide-x">
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={
            "flex items-center gap-3 px-4 py-3 " +
            (i >= 2 ? "border-t border-slate-200 dark:border-slate-800 sm:border-t-0 " : "") +
            (i % 2 === 1 ? "border-l border-slate-200 dark:border-slate-800 sm:border-l-0 " : "")
          }
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {c.icon}
          </span>
          <span className="min-w-0">
            <span className="block text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {c.value}
            </span>
            <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {c.label}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────── Toolbar ────────────────────────────────────

function Toolbar({
  query,
  onQuery,
  searchRef,
  sort,
  onSort,
  view,
  onView,
}: {
  query: string;
  onQuery: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement>;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1">
        <Search
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
        />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search by title, summary, URL, or tag…"
          className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-10 pr-10 text-sm text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X size={15} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500 sm:inline-block">
            /
          </kbd>
        )}
      </div>

      <SortMenu sort={sort} onSort={onSort} />

      <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
        <ViewButton active={view === "grid"} onClick={() => onView("grid")} label="Grid view">
          <LayoutGrid size={15} />
        </ViewButton>
        <ViewButton active={view === "list"} onClick={() => onView("list")} label="List view">
          <List size={15} />
        </ViewButton>
      </div>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={
        "flex h-8 w-8 items-center justify-center rounded-md transition " +
        (active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300")
      }
    >
      {children}
    </button>
  );
}

function SortMenu({ sort, onSort }: { sort: SortKey; onSort: (v: SortKey) => void }) {
  const [open, setOpen] = React.useState(false);
  const current = SORT_OPTIONS.find((o) => o.key === sort) ?? SORT_OPTIONS[0];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-[42px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
      >
        <SlidersHorizontal size={15} className="text-slate-400" />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown size={13} className="text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => {
                  onSort(o.key);
                  setOpen(false);
                }}
                className={
                  "flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 " +
                  (sort === o.key
                    ? "text-indigo-600 dark:text-indigo-300"
                    : "text-slate-700 dark:text-slate-200")
                }
              >
                {o.label}
                {sort === o.key && <Check size={14} className="shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────── Kind filter ────────────────────────────────

function KindFilterBar({
  kinds,
  selected,
  onSelect,
}: {
  kinds: ResourceSourceKind[];
  selected: ResourceSourceKind | null;
  onSelect: (kind: ResourceSourceKind | null) => void;
}) {
  if (kinds.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-slate-500">
        <SlidersHorizontal size={12} /> Type
      </span>
      <KindChip active={selected === null} onClick={() => onSelect(null)}>
        All
      </KindChip>
      {kinds.map((k) => (
        <KindChip key={k} active={selected === k} onClick={() => onSelect(k)}>
          <SourceKindIcon kind={k} size={12} />
          {KIND_LABEL[k]}
        </KindChip>
      ))}
    </div>
  );
}

function KindChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition " +
        (active
          ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600")
      }
    >
      {children}
    </button>
  );
}

// ───────────────────────────── Grid view ────────────────────────────────

function ResourceGrid({ company, items }: { company: Company; items: Resource[] }) {
  const navigate = useNavigate();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((r) => (
        <button
          key={r.id}
          onClick={() => navigate(`/c/${company.slug}/resources/${r.slug}`)}
          className="group flex min-h-[9.5rem] flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-700"
        >
          <div className="mb-2.5 flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-50 to-violet-50 text-indigo-600 ring-1 ring-indigo-100 dark:from-indigo-500/15 dark:to-violet-500/15 dark:text-indigo-300 dark:ring-indigo-500/20">
              <SourceKindIcon kind={r.sourceKind} size={17} />
            </span>
            {r.status !== "ready" ? (
              <StatusBadge status={r.status} />
            ) : (
              <ArrowUpRight
                size={15}
                className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-indigo-500 dark:text-slate-600"
              />
            )}
          </div>
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {r.title}
          </h3>
          {r.summary && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {r.summary}
            </p>
          )}
          <div className="flex-1" />
          {r.tags.length > 0 && (
            <div className="mt-3">
              <TagChips tags={r.tags} limit={3} />
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2.5 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <span className="font-medium text-slate-500 dark:text-slate-400">
              {KIND_LABEL[r.sourceKind]}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatBodyLength(r.bodyLength)}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums" title={new Date(r.updatedAt).toLocaleString()}>
              {timeAgo(r.updatedAt)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── List view ────────────────────────────────

function ResourceList({ company, items }: { company: Company; items: Resource[] }) {
  const navigate = useNavigate();
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      {items.map((r, i) => (
        <button
          key={r.id}
          onClick={() => navigate(`/c/${company.slug}/resources/${r.slug}`)}
          className={
            "group flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60 " +
            (i > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
          }
        >
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <SourceKindIcon kind={r.sourceKind} size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {r.title}
              </span>
              {r.status !== "ready" && <StatusBadge status={r.status} />}
            </span>
            {r.summary && (
              <span className="mt-0.5 line-clamp-1 text-xs text-slate-500 dark:text-slate-400">
                {r.summary}
              </span>
            )}
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
              <span>{KIND_LABEL[r.sourceKind]}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatBodyLength(r.bodyLength)}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums" title={new Date(r.updatedAt).toLocaleString()}>
                {timeAgo(r.updatedAt)}
              </span>
              {r.createdBy && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1">
                    <User size={11} /> {r.createdBy.name}
                  </span>
                </>
              )}
              {r.tags.length > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <TagChips tags={r.tags} limit={4} />
                </>
              )}
            </span>
          </span>
          <ArrowUpRight
            size={14}
            className="mt-1 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-slate-500 dark:text-slate-600"
          />
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────── Empty state ────────────────────────────────

function EmptyHero({ onPick }: { onPick: (kind: NewResourceTab) => void }) {
  const tiles: {
    kind: NewResourceTab;
    icon: React.ReactNode;
    label: string;
    hint: string;
  }[] = [
    {
      kind: "url",
      icon: <Globe size={18} />,
      label: "Paste a URL",
      hint: "Articles, blog posts, docs",
    },
    {
      kind: "text",
      icon: <ClipboardPaste size={18} />,
      label: "Paste text",
      hint: "Notes, transcripts, snippets",
    },
    {
      kind: "file",
      icon: <Upload size={18} />,
      label: "Upload a file",
      hint: "PDF, EPUB, TXT, MD, HTML",
    },
  ];
  return (
    <div className="mt-8 rounded-2xl border border-dashed border-slate-200 bg-white px-8 py-14 text-center dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-50 to-violet-50 text-indigo-600 ring-1 ring-indigo-100 dark:from-indigo-500/15 dark:to-violet-500/15 dark:text-indigo-300 dark:ring-indigo-500/20">
        <Library size={26} />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Build a shelf for your team to study
      </h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Articles, ebooks, transcripts, briefs — anything you want every AI
        employee to be able to read and search. Pick how you want to add the
        first one.
      </p>
      <div className="mx-auto mt-6 grid max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-3">
        {tiles.map((t) => (
          <button
            key={t.kind}
            onClick={() => onPick(t.kind)}
            className="group flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-5 text-center transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-600 transition group-hover:bg-indigo-100 group-hover:text-indigo-600 dark:bg-slate-800 dark:text-slate-300 dark:group-hover:bg-indigo-500/15 dark:group-hover:text-indigo-300">
              {t.icon}
            </span>
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {t.label}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{t.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── Shared helpers ─────────────────────────────

export function SourceKindIcon({
  kind,
  size = 18,
}: {
  kind: ResourceSourceKind;
  size?: number;
}) {
  if (kind === "url") return <Globe size={size} />;
  if (kind === "pdf") return <FileText size={size} />;
  if (kind === "epub") return <BookOpen size={size} />;
  if (kind === "video") return <Video size={size} />;
  return <Sparkles size={size} />;
}

function StatusBadge({ status }: { status: Resource["status"] }) {
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
        <AlertCircle size={10} /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
      <Loader2 size={10} className="animate-spin" /> {status}
    </span>
  );
}

export function formatBodyLength(n: number): string {
  if (n <= 0) return "0 chars";
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K chars`;
  return `${(n / 1_000_000).toFixed(2)}M chars`;
}

export function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "3m ago" / "yesterday" for list & card rows; absolute date on hover. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

// ─────────────────────────── Sort / view config ─────────────────────────

type SortKey = "updated" | "created" | "title" | "size";
type ViewMode = "grid" | "list";

const SORT_KEYS: readonly SortKey[] = ["updated", "created", "title", "size"];
const VIEW_MODES: readonly ViewMode[] = ["grid", "list"];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Recently updated" },
  { key: "created", label: "Recently added" },
  { key: "title", label: "Title (A–Z)" },
  { key: "size", label: "Largest first" },
];

const SORTERS: Record<SortKey, (a: Resource, b: Resource) => number> = {
  updated: (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
  created: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  title: (a, b) => a.title.localeCompare(b.title),
  size: (a, b) => Number(b.bytes || 0) - Number(a.bytes || 0),
};

const KIND_ORDER: ResourceSourceKind[] = ["url", "text", "pdf", "epub", "video"];
const KIND_LABEL: Record<ResourceSourceKind, string> = {
  url: "Link",
  text: "Text",
  pdf: "PDF",
  epub: "EPUB",
  video: "Video",
};

const PREF_PREFIX = "genosyn.resources.";

function readPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(PREF_PREFIX + key);
    if (stored && (allowed as readonly string[]).includes(stored)) return stored as T;
  } catch {
    // localStorage can throw in private mode — fall back to the default
  }
  return fallback;
}

function writePref(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_PREFIX + key, value);
  } catch {
    // best-effort persistence; ignore quota / privacy-mode errors
  }
}

// ─────────────────────────── New Resource modal ─────────────────────────

type NewResourceTab = "url" | "text" | "file";

function NewResourceModal({
  open,
  company,
  initialTab,
  onClose,
  onCreated,
}: {
  open: boolean;
  company: Company;
  initialTab: NewResourceTab;
  onClose: () => void;
  onCreated: (row: Resource) => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = React.useState<NewResourceTab>(initialTab);
  const [busy, setBusy] = React.useState(false);

  // Shared fields
  const [title, setTitle] = React.useState("");
  const [tags, setTags] = React.useState<CompanyTag[]>([]);

  // URL tab
  const [url, setUrl] = React.useState("");

  // Text tab
  const [body, setBody] = React.useState("");

  // File tab
  const [file, setFile] = React.useState<File | null>(null);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setBusy(false);
      setTitle("");
      setTags([]);
      setUrl("");
      setBody("");
      setFile(null);
      setDragging(false);
    } else {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  async function submit() {
    setBusy(true);
    try {
      let row: Resource;
      if (tab === "url") {
        if (!url.trim()) throw new Error("Paste a URL first.");
        row = await api.post<Resource>(`/api/companies/${company.id}/resources`, {
          sourceKind: "url",
          url: url.trim(),
          title: title.trim() || undefined,
          tagIds: tags.map((tag) => tag.id),
        });
      } else if (tab === "text") {
        if (!title.trim()) throw new Error("Give it a title.");
        if (!body.trim()) throw new Error("Paste the text first.");
        row = await api.post<Resource>(`/api/companies/${company.id}/resources`, {
          sourceKind: "text",
          title: title.trim(),
          body,
          tagIds: tags.map((tag) => tag.id),
        });
      } else {
        if (!file) throw new Error("Choose a file first.");
        const fd = new FormData();
        fd.append("file", file);
        if (title.trim()) fd.append("title", title.trim());
        if (tags.length) fd.append("tagIds", JSON.stringify(tags.map((tag) => tag.id)));
        const res = await fetch(`/api/companies/${company.id}/resources/upload`, {
          method: "POST",
          credentials: "same-origin",
          body: fd,
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) {
          throw new Error((data && (data.error ?? data.message)) || res.statusText);
        }
        row = data as Resource;
      }
      if (row.status === "failed") {
        toast(`Saved, but ingestion failed: ${row.errorMessage}`, "error");
      } else {
        toast("Resource ingested", "success");
      }
      onCreated(row);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add resource" size="lg">
      <div className="flex flex-col gap-4">
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm dark:border-slate-700 dark:bg-slate-800">
          <TabButton active={tab === "url"} onClick={() => setTab("url")}>
            <Globe size={14} /> URL
          </TabButton>
          <TabButton active={tab === "text"} onClick={() => setTab("text")}>
            <ClipboardPaste size={14} /> Paste
          </TabButton>
          <TabButton active={tab === "file"} onClick={() => setTab("file")}>
            <Upload size={14} /> Upload
          </TabButton>
        </div>

        {tab === "url" && (
          <>
            <Input
              label="URL"
              placeholder="https://example.com/article"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
            <Input
              label="Title (optional — defaults to the page title)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Founders' guide to pricing"
            />
          </>
        )}

        {tab === "text" && (
          <>
            <Input
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            <Textarea
              label="Content"
              placeholder="Paste the article, transcript, or notes here…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
            />
          </>
        )}

        {tab === "file" && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                File
              </label>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) setFile(dropped);
                }}
                className={
                  "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-6 py-8 text-center transition " +
                  (dragging
                    ? "border-indigo-400 bg-indigo-50/60 dark:border-indigo-600 dark:bg-indigo-500/10"
                    : "border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/40 dark:hover:border-slate-600")
                }
              >
                <Upload size={20} className="text-slate-400 dark:text-slate-500" />
                {file ? (
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {file.name}{" "}
                    <span className="font-normal text-slate-400">
                      ({formatBytes(file.size)})
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-slate-600 dark:text-slate-300">
                    <span className="font-medium text-indigo-600 dark:text-indigo-400">
                      Click to choose
                    </span>{" "}
                    or drag a file here
                  </span>
                )}
                <input
                  type="file"
                  accept=".pdf,.epub,.txt,.md,.markdown,.html,.htm,.mp4,.mov,.webm,.mkv,.avi"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                PDF, EPUB, TXT, MD, or HTML. 25 MB max. Video uploads are
                stored but transcripts aren&apos;t auto-generated yet — paste
                the transcript as text instead.
              </p>
            </div>
            <Input
              label="Title (optional — defaults to filename)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </>
        )}

        <TagPicker companyId={company.id} value={tags} onChange={setTags} />

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Spinner size={14} />}
            {busy ? "Ingesting…" : "Add resource"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition " +
        (active
          ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100"
          : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200")
      }
    >
      {children}
    </button>
  );
}
