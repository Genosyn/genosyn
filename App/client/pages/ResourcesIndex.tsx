import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Clock,
  ClipboardPaste,
  FileText,
  Globe,
  Library,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Upload,
  Video,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { Spinner } from "../components/ui/Spinner";
import {
  api,
  Company,
  Resource,
  ResourceSourceKind,
} from "../lib/api";

/**
 * Resources — knowledge ingestion. Humans paste a URL, paste raw text,
 * or upload a file (PDF / EPUB / TXT / MD / HTML / video). The server
 * extracts plain text and stores it on the row; AI employees query the
 * result via MCP tools.
 *
 * v1 is intentionally flat: no folder tree, no embeddings. A later
 * milestone can group / vectorize once we know what kinds of material
 * teams actually feed in.
 */
export default function ResourcesIndex({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [items, setItems] = React.useState<Resource[] | null>(null);
  const [showNew, setShowNew] = React.useState(false);
  const [tab, setTab] = React.useState<NewResourceTab>("url");
  const [query, setQuery] = React.useState("");

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

  function openNew(initial: NewResourceTab) {
    setTab(initial);
    setShowNew(true);
  }

  const filtered = React.useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) => {
      const hay =
        r.title.toLowerCase() +
        " " +
        (r.summary ?? "").toLowerCase() +
        " " +
        (r.tags ?? "").toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Resources" },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pt-12 pb-16">
          <div className="mb-8">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Resources
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {company.name}
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              External material — articles, ebooks, transcripts — that AI
              employees can study and search later. Paste a URL, drop a file,
              or paste raw text. Each entry is searchable through the built-in
              MCP tools.
            </p>
          </div>

          <div className="relative mb-6">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search resources by title, summary, or tag…"
              className="w-full rounded-lg border border-slate-200 bg-white py-3 pl-11 pr-4 text-base text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
          </div>

          <QuickAddRow onPick={openNew} />

          {items === null ? (
            <div className="mt-10 flex h-32 items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : items.length === 0 ? (
            <EmptyHero onPick={openNew} />
          ) : filtered && filtered.length === 0 ? (
            <div className="mt-10 rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              No resources match <span className="font-medium">{query}</span>.
            </div>
          ) : (
            <ResourceList
              company={company}
              items={filtered ?? []}
              onPickAdd={openNew}
            />
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

// ─────────────────────────── Quick add row ──────────────────────────────

type NewResourceTab = "url" | "text" | "file";

function QuickAddRow({ onPick }: { onPick: (kind: NewResourceTab) => void }) {
  const tiles: {
    kind: NewResourceTab;
    icon: React.ReactNode;
    label: string;
    hint: string;
  }[] = [
    {
      kind: "url",
      icon: <Globe size={16} />,
      label: "Paste a URL",
      hint: "Articles, blog posts, docs",
    },
    {
      kind: "text",
      icon: <ClipboardPaste size={16} />,
      label: "Paste text",
      hint: "Notes, transcripts, snippets",
    },
    {
      kind: "file",
      icon: <Upload size={16} />,
      label: "Upload a file",
      hint: "PDF, EPUB, TXT, MD, HTML",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {tiles.map((t) => (
        <button
          key={t.kind}
          onClick={() => onPick(t.kind)}
          className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-indigo-300 hover:bg-indigo-50/30 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600 group-hover:bg-indigo-100 group-hover:text-indigo-600 dark:bg-slate-800 dark:text-slate-300 dark:group-hover:bg-indigo-500/15 dark:group-hover:text-indigo-300">
            {t.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {t.label}
            </span>
            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
              {t.hint}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── List view ────────────────────────────────

function ResourceList({
  company,
  items,
  onPickAdd,
}: {
  company: Company;
  items: Resource[];
  onPickAdd: (kind: NewResourceTab) => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Clock size={12} />
          {items.length} {items.length === 1 ? "resource" : "resources"}
        </div>
        <button
          onClick={() => onPickAdd("url")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
        >
          <Plus size={12} /> Add
        </button>
      </div>
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
                <span className="mt-0.5 block line-clamp-1 text-xs text-slate-500 dark:text-slate-400">
                  {r.summary}
                </span>
              )}
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
                <span className="capitalize">{r.sourceKind}</span>
                <span aria-hidden>·</span>
                <span>{formatBodyLength(r.bodyLength)}</span>
                {r.tagList.length > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="flex flex-wrap gap-1">
                      {r.tagList.slice(0, 4).map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {t}
                        </span>
                      ))}
                    </span>
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
    </div>
  );
}

// ─────────────────────────── Empty state ────────────────────────────────

function EmptyHero({ onPick }: { onPick: (kind: NewResourceTab) => void }) {
  return (
    <div className="mt-10 rounded-xl border border-dashed border-slate-200 bg-white px-8 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
        <Library size={22} />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Build a shelf for your team to study
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Articles, ebooks, transcripts, briefs — anything you want every AI
        employee to be able to read and search. Pick how you want to add the
        first one.
      </p>
      <div className="mx-auto mt-5 flex max-w-sm flex-wrap items-center justify-center gap-2">
        <button
          onClick={() => onPick("url")}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <Globe size={14} /> Paste a URL
        </button>
        <button
          onClick={() => onPick("text")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
        >
          <ClipboardPaste size={14} /> Paste text
        </button>
        <button
          onClick={() => onPick("file")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
        >
          <Upload size={14} /> Upload
        </button>
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

// ─────────────────────────── New Resource modal ─────────────────────────

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
  const [tags, setTags] = React.useState("");

  // URL tab
  const [url, setUrl] = React.useState("");

  // Text tab
  const [body, setBody] = React.useState("");

  // File tab
  const [file, setFile] = React.useState<File | null>(null);

  React.useEffect(() => {
    if (!open) {
      setBusy(false);
      setTitle("");
      setTags("");
      setUrl("");
      setBody("");
      setFile(null);
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
        row = await api.post<Resource>(
          `/api/companies/${company.id}/resources`,
          {
            sourceKind: "url",
            url: url.trim(),
            title: title.trim() || undefined,
            tags: tags.trim() || undefined,
          },
        );
      } else if (tab === "text") {
        if (!title.trim()) throw new Error("Give it a title.");
        if (!body.trim()) throw new Error("Paste the text first.");
        row = await api.post<Resource>(
          `/api/companies/${company.id}/resources`,
          {
            sourceKind: "text",
            title: title.trim(),
            body,
            tags: tags.trim() || undefined,
          },
        );
      } else {
        if (!file) throw new Error("Choose a file first.");
        const fd = new FormData();
        fd.append("file", file);
        if (title.trim()) fd.append("title", title.trim());
        if (tags.trim()) fd.append("tags", tags.trim());
        const res = await fetch(
          `/api/companies/${company.id}/resources/upload`,
          {
            method: "POST",
            credentials: "same-origin",
            body: fd,
          },
        );
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) {
          throw new Error(
            (data && (data.error ?? data.message)) || res.statusText,
          );
        }
        row = data as Resource;
      }
      if (row.status === "failed") {
        toast(
          `Saved, but ingestion failed: ${row.errorMessage}`,
          "error",
        );
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
              <input
                type="file"
                accept=".pdf,.epub,.txt,.md,.markdown,.html,.htm,.mp4,.mov,.webm,.mkv,.avi"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50 dark:text-slate-200 dark:file:border-slate-700 dark:file:bg-slate-900 dark:file:text-slate-100 dark:hover:file:bg-slate-800"
              />
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

        <Input
          label="Tags (optional, comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="pricing, b2b, growth"
        />

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
