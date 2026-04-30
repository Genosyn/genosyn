import React from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  FileText,
  Globe,
  Plus,
  Sparkles,
  Upload,
  AlertCircle,
  Loader2,
  Video,
  ArrowRight,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/ui/Toast";
import { Spinner } from "../components/ui/Spinner";
import {
  api,
  Company,
  Learning,
  LearningSourceKind,
} from "../lib/api";

/**
 * Learnings — knowledge ingestion. Humans paste a URL, paste raw text,
 * or upload a file (PDF / EPUB / TXT / MD / HTML / video). The server
 * extracts plain text and stores it on the row; AI employees query the
 * result via MCP tools.
 *
 * v1 is intentionally flat: no folder tree, no embeddings. A later
 * milestone can group / vectorize once we know what kinds of material
 * teams actually feed in.
 */
export default function LearningsIndex({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [items, setItems] = React.useState<Learning[] | null>(null);
  const [showNew, setShowNew] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const rows = await api.get<Learning[]>(
        `/api/companies/${company.id}/learnings`,
      );
      setItems(rows);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load learnings",
        "error",
      );
      setItems([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs items={[{ label: "Learnings" }]} />
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              Learnings
            </h1>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              Articles, ebooks, transcripts your team wants AI employees to
              study. Paste a URL, drop a PDF or EPUB, or paste raw text — the
              extracted content becomes searchable through the MCP tools.
            </p>
          </div>
          <Button onClick={() => setShowNew(true)}>
            <Plus size={14} /> Add learning
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6">
        {items === null ? (
          <div className="flex h-48 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing to study yet"
            description="Add a URL, ebook, or paste of any reference material your AI employees should know about. Each learning is searchable through the built-in MCP tools."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus size={14} /> Add learning
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((l) => (
              <button
                key={l.id}
                onClick={() =>
                  navigate(`/c/${company.slug}/learnings/${l.slug}`)
                }
                className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                    <SourceKindIcon kind={l.sourceKind} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                      {l.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="capitalize">{l.sourceKind}</span>
                      <span>·</span>
                      <span>{formatBodyLength(l.bodyLength)}</span>
                      {l.status !== "ready" && (
                        <>
                          <span>·</span>
                          <StatusBadge status={l.status} />
                        </>
                      )}
                    </div>
                  </div>
                  <ArrowRight
                    size={16}
                    className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500 dark:text-slate-600"
                  />
                </div>
                {l.summary && (
                  <p className="mt-3 line-clamp-3 text-sm text-slate-600 dark:text-slate-300">
                    {l.summary}
                  </p>
                )}
                {l.tagList.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {l.tagList.slice(0, 4).map((t) => (
                      <span
                        key={t}
                        className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <NewLearningModal
        open={showNew}
        company={company}
        onClose={() => setShowNew(false)}
        onCreated={(row) => {
          setShowNew(false);
          reload();
          navigate(`/c/${company.slug}/learnings/${row.slug}`);
        }}
      />
    </div>
  );
}

function SourceKindIcon({ kind }: { kind: LearningSourceKind }) {
  const size = 18;
  if (kind === "url") return <Globe size={size} />;
  if (kind === "pdf") return <FileText size={size} />;
  if (kind === "epub") return <BookOpen size={size} />;
  if (kind === "video") return <Video size={size} />;
  return <Sparkles size={size} />;
}

function StatusBadge({ status }: { status: Learning["status"] }) {
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
        <AlertCircle size={12} /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
      <Loader2 size={12} className="animate-spin" /> {status}
    </span>
  );
}

export function formatBodyLength(n: number): string {
  if (n <= 0) return "0 chars";
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K chars`;
  return `${(n / 1_000_000).toFixed(2)}M chars`;
}

// ---------------- New Learning modal ----------------

type Tab = "url" | "text" | "file";

function NewLearningModal({
  open,
  company,
  onClose,
  onCreated,
}: {
  open: boolean;
  company: Company;
  onClose: () => void;
  onCreated: (row: Learning) => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = React.useState<Tab>("url");
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
      setTab("url");
      setBusy(false);
      setTitle("");
      setTags("");
      setUrl("");
      setBody("");
      setFile(null);
    }
  }, [open]);

  async function submit() {
    setBusy(true);
    try {
      let row: Learning;
      if (tab === "url") {
        if (!url.trim()) throw new Error("Paste a URL first.");
        row = await api.post<Learning>(
          `/api/companies/${company.id}/learnings`,
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
        row = await api.post<Learning>(
          `/api/companies/${company.id}/learnings`,
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
          `/api/companies/${company.id}/learnings/upload`,
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
        row = data as Learning;
      }
      if (row.status === "failed") {
        toast(
          `Saved, but ingestion failed: ${row.errorMessage}`,
          "error",
        );
      } else {
        toast("Learning ingested", "success");
      }
      onCreated(row);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add learning" size="lg">
      <div className="flex flex-col gap-4">
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm dark:border-slate-700 dark:bg-slate-800">
          <TabButton active={tab === "url"} onClick={() => setTab("url")}>
            <Globe size={14} /> URL
          </TabButton>
          <TabButton active={tab === "text"} onClick={() => setTab("text")}>
            <Sparkles size={14} /> Paste
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
            {busy ? "Ingesting…" : "Add learning"}
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
