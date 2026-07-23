import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import ePub from "epubjs";
import type { Book, Rendition } from "epubjs";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Hash,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Printer,
  Save,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import {
  api,
  Company,
  Resource,
  ResourceAccessLevel,
  ResourceGrant,
  ResourceGrantCandidate,
  ResourceGrantsResponse,
} from "../lib/api";
import { ResourceTagPicker } from "../components/TagPicker";
import { SourceKindIcon, formatBodyLength, formatBytes, timeAgo } from "./ResourcesIndex";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Resource detail — opinionated per source kind. The rule of thumb is
 * "show the original, not the extracted preview": text bodies render (and
 * edit) as markdown; PDFs go in a native browser viewer; EPUBs render via
 * epubjs; URLs surface as a prominent link out; videos use the native
 * `<video>` element. The auto-generated summary used to take up the top
 * of the page — it's been dropped here because it just duplicated the
 * body. The summary is still produced server-side for the index list
 * preview.
 */
export default function ResourceDetail({ company }: { company: Company }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [row, setRow] = React.useState<Resource | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [showShare, setShowShare] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);

  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");

  const reload = React.useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const r = await api.get<Resource>(`/api/companies/${company.id}/resources/${slug}`);
      setRow(r);
      setTitle(r.title);
      setBody(r.bodyText ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load resource", "error");
    } finally {
      setLoading(false);
    }
  }, [company.id, slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Live-refresh only while NOT editing — a broadcast must never stomp the
  // markdown a human is mid-edit on. Viewers still pick up ingestion
  // (pending → ready) and others' saves, silently (no full-page spinner).
  const liveReload = React.useCallback(async () => {
    if (editing || !slug) return;
    try {
      const r = await api.get<Resource>(`/api/companies/${company.id}/resources/${slug}`);
      setRow(r);
      setTitle(r.title);
      setBody(r.bodyText ?? "");
    } catch {
      // A missed refresh is self-correcting on the next event or reload.
    }
  }, [company.id, slug, editing]);
  useLiveRefetch("resource", liveReload);

  async function save() {
    if (!row) return;
    try {
      const payload: Record<string, string> = {
        title: title.trim(),
      };
      if (row.sourceKind === "text") payload.body = body;
      const updated = await api.patch<Resource>(
        `/api/companies/${company.id}/resources/${row.slug}`,
        payload,
      );
      setRow(updated);
      setBody(updated.bodyText ?? "");
      setEditing(false);
      toast("Saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function cancelEdit() {
    if (!row) return;
    setTitle(row.title);
    setBody(row.bodyText ?? "");
    setEditing(false);
  }

  async function remove() {
    if (!row) return;
    const ok = await dialog.confirm({
      title: "Delete this resource?",
      message:
        "Both the extracted text and the original file (if any) are removed. AI employees lose access immediately.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/resources/${row.slug}`);
      toast("Deleted", "success");
      navigate(`/c/${company.slug}/resources`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if (!row) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Resource not found
        </h2>
        <Button variant="secondary" onClick={() => navigate(`/c/${company.slug}/resources`)}>
          <ArrowLeft size={14} /> Back to resources
        </Button>
      </div>
    );
  }

  const fileUrl = `/api/companies/${company.id}/resources/${row.slug}/file`;
  const downloadUrl = `${fileUrl}?disposition=attachment`;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Resources", to: `/c/${company.slug}/resources` },
            { label: row.title },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 pb-20 pt-10 md:px-10">
          {/* Hero */}
          <header className="mb-6 flex items-start gap-4">
            <span className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 text-indigo-600 ring-1 ring-indigo-100 dark:from-indigo-500/15 dark:to-violet-500/15 dark:text-indigo-300 dark:ring-indigo-500/20">
              <SourceKindIcon kind={row.sourceKind} size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 uppercase tracking-wide dark:bg-slate-800">
                  {row.sourceKind}
                </span>
                <span className="tabular-nums">{formatBodyLength(row.bodyLength)}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{formatBytes(row.bytes)}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums" title={new Date(row.createdAt).toLocaleString()}>
                  Added {timeAgo(row.createdAt)}
                </span>
                {row.createdBy && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1">
                      <Users size={12} /> {row.createdBy.name}
                    </span>
                  </>
                )}
                {row.status !== "ready" && (
                  <>
                    <span aria-hidden>·</span>
                    <StatusBadge status={row.status} />
                  </>
                )}
              </div>
              {editing ? (
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="!text-3xl !font-bold"
                />
              ) : (
                <h1 className="break-words text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  {row.title}
                </h1>
              )}
              {row.sourceUrl && !editing && (
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <span className="max-w-[28rem] truncate">{hostnameOf(row.sourceUrl)}</span>
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </header>

          {/* Action bar */}
          <div className="mb-6 flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Button onClick={save}>
                  <Save size={14} /> Save
                </Button>
                <Button variant="secondary" onClick={cancelEdit}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button variant="secondary" onClick={() => setShowShare(true)}>
                  <Users size={14} /> Share
                </Button>
                {row.sourceKind === "text" && (
                  <DownloadMenu
                    companyId={company.id}
                    slug={row.slug}
                    hasBody={(row.bodyText ?? "").trim().length > 0}
                  />
                )}
                {row.storageKey && (
                  <a
                    href={downloadUrl}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
                  >
                    <Download size={14} /> Original
                  </a>
                )}
                {row.sourceUrl && (
                  <a
                    href={row.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
                  >
                    <ExternalLink size={14} /> Open original
                  </a>
                )}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={remove}
                  title="Delete resource"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>

          <div className="mb-6 max-w-xl">
            <ResourceTagPicker
              companyId={company.id}
              resourceType="resource"
              resourceId={row.id}
              value={row.tags}
              onSaved={(tags) =>
                setRow((current) =>
                  current ? { ...current, tags, tagList: tags.map((tag) => tag.name) } : current,
                )
              }
            />
          </div>

          {/* Failed-ingest banner */}
          {row.status === "failed" && row.errorMessage && (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Ingestion failed</div>
                <div className="mt-0.5">{row.errorMessage}</div>
              </div>
            </div>
          )}

          {/* Content — type-specific */}
          <section>
            {row.sourceKind === "text" && (
              <TextContent
                editing={editing}
                body={body}
                bodyText={row.bodyText ?? ""}
                onChange={setBody}
              />
            )}
            {row.sourceKind === "pdf" && row.storageKey && (
              <PdfViewer fileUrl={fileUrl} title={row.title} />
            )}
            {row.sourceKind === "epub" && row.storageKey && <EpubViewer fileUrl={fileUrl} />}
            {row.sourceKind === "video" && row.storageKey && <VideoContent fileUrl={fileUrl} />}
            {row.sourceKind === "url" && (
              <UrlContent
                resource={row}
                showRaw={showRaw}
                onToggleRaw={() => setShowRaw((v) => !v)}
              />
            )}
          </section>

          {/* Extracted-text fallback toggle for PDF/EPUB — handy when the
              viewer fails (e.g. file lost on disk) or AI users want to see
              what's actually being indexed for search. */}
          {(row.sourceKind === "pdf" || row.sourceKind === "epub") && row.bodyText && (
            <ExtractedFallback bodyText={row.bodyText} />
          )}
        </div>
      </div>

      <ShareModal
        open={showShare}
        company={company}
        resource={row}
        onClose={() => setShowShare(false)}
        onChanged={reload}
      />
    </div>
  );
}

// ─────────────────────────── Text content ──────────────────────────────

function TextContent({
  editing,
  body,
  bodyText,
  onChange,
}: {
  editing: boolean;
  body: string;
  bodyText: string;
  onChange: (v: string) => void;
}) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea to fit content so the editor reads like a
  // document rather than a tiny chat box. Cap at 80vh so absurdly long
  // pastes still scroll inside their own region.
  React.useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.8)}px`;
  }, [editing, body]);

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <FileText size={12} /> Markdown
          </span>
          <span className="tabular-nums">{body.length.toLocaleString()} chars</span>
        </div>
        <textarea
          ref={ref}
          value={body}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Write in markdown — # headings, **bold**, [links](https://…), lists, code, tables…"
          className="min-h-[24rem] w-full resize-none rounded-xl border border-slate-200 bg-white p-5 font-mono text-[13.5px] leading-7 text-slate-800 shadow-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
          spellCheck={false}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500">
          Saved bodies are searchable through the MCP <code>search_resources</code> tool.
        </p>
      </div>
    );
  }

  if (!bodyText) {
    return (
      <p className="text-sm italic text-slate-400 dark:text-slate-500">
        Nothing here yet — click <span className="font-medium">Edit</span> to add markdown.
      </p>
    );
  }

  return (
    <article className="rounded-xl border border-slate-200 bg-white px-7 py-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <Markdown body={bodyText} />
    </article>
  );
}

// ─────────────────────────── Download menu ─────────────────────────────

/**
 * Text-resource downloader. The body is stored as markdown; the server
 * `/resources/:slug/export` endpoint renders it on demand into one of
 * four formats. PDF in particular is rendered through Chromium so the
 * file the human downloads is the same document the AI employees see
 * via the `export_resource` MCP tool — no print-dialog detour, no
 * client-side PDF library bloat.
 */
function DownloadMenu({
  companyId,
  slug,
  hasBody,
}: {
  companyId: string;
  slug: string;
  hasBody: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const { toast } = useToast();
  const disabled = !hasBody;

  async function download(format: "md" | "txt" | "html" | "pdf") {
    setBusy(format);
    try {
      const res = await fetch(
        `/api/companies/${companyId}/resources/${slug}/export?format=${format}`,
      );
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          // body wasn't JSON — keep the status-code message
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        filenameFromContentDisposition(res.headers.get("Content-Disposition")) ??
        `${slug}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  }

  const options: {
    label: string;
    hint: string;
    icon: React.ReactNode;
    format: "md" | "txt" | "html" | "pdf";
  }[] = [
    {
      label: "PDF",
      hint: ".pdf — printable document",
      icon: <Printer size={14} />,
      format: "pdf",
    },
    {
      label: "HTML",
      hint: ".html — rendered web page",
      icon: <Code size={14} />,
      format: "html",
    },
    {
      label: "Markdown",
      hint: ".md — original source",
      icon: <Hash size={14} />,
      format: "md",
    },
    {
      label: "Plain text",
      hint: ".txt",
      icon: <FileText size={14} />,
      format: "txt",
    },
  ];

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled || busy !== null}
        onClick={() => setOpen((v) => !v)}
        title={disabled ? "Nothing to download yet" : "Download as…"}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-300 disabled:opacity-50 disabled:hover:border-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:disabled:hover:border-slate-700"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {busy ? `Rendering ${busy.toUpperCase()}…` : "Download"}
        {!busy && <ChevronDown size={12} className="text-slate-400" />}
      </button>
      {open && !busy && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {options.map((o) => (
              <button
                key={o.format}
                type="button"
                onClick={() => download(o.format)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <span className="mt-0.5 text-slate-400 dark:text-slate-500">{o.icon}</span>
                <span className="flex-1">
                  <span className="block">{o.label}</span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    {o.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match ? match[1] : null;
}

// ─────────────────────────── PDF viewer ────────────────────────────────

function PdfViewer({ fileUrl, title }: { fileUrl: string; title: string }) {
  const [fullscreen, setFullscreen] = React.useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-sm dark:border-slate-700 dark:bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <FileText size={12} /> PDF
        </span>
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      <iframe
        src={fileUrl}
        title={title}
        className={
          fullscreen
            ? "fixed inset-0 z-50 h-screen w-screen border-0 bg-white"
            : "h-[78vh] w-full border-0 bg-white"
        }
      />
    </div>
  );
}

// ─────────────────────────── EPUB viewer ───────────────────────────────

interface TocItem {
  href: string;
  label: string;
}

function EpubViewer({ fileUrl }: { fileUrl: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const bookRef = React.useRef<Book | null>(null);
  const renditionRef = React.useRef<Rendition | null>(null);
  const [toc, setToc] = React.useState<TocItem[]>([]);
  const [tocOpen, setTocOpen] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);

  const isDark = React.useMemo(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    [],
  );

  React.useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    const book = ePub(fileUrl);
    bookRef.current = book;
    const rendition = book.renderTo(containerRef.current, {
      width: "100%",
      height: "70vh",
      flow: "scrolled-doc",
      allowScriptedContent: false,
    });
    renditionRef.current = rendition;
    rendition.themes.register("light", {
      body: {
        color: "#0f172a",
        background: "#ffffff",
        "font-family":
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
        "line-height": "1.7",
        padding: "1.25rem 1.5rem",
      },
    });
    rendition.themes.register("dark", {
      body: {
        color: "#e2e8f0",
        background: "#0f172a",
        "font-family":
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
        "line-height": "1.7",
        padding: "1.25rem 1.5rem",
      },
      a: { color: "#818cf8" },
    });
    rendition.themes.select(isDark ? "dark" : "light");
    rendition.themes.fontSize("105%");

    rendition
      .display()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });

    book.ready.then(async () => {
      if (cancelled) return;
      try {
        const nav = await book.loaded.navigation;
        const flat: TocItem[] = [];
        const walk = (items: Array<{ href: string; label: string; subitems?: unknown[] }>) => {
          for (const it of items) {
            flat.push({ href: it.href, label: (it.label ?? "").trim() });
            if (Array.isArray(it.subitems) && it.subitems.length) {
              walk(it.subitems as Array<{ href: string; label: string; subitems?: unknown[] }>);
            }
          }
        };
        walk((nav.toc ?? []) as Array<{ href: string; label: string; subitems?: unknown[] }>);
        if (!cancelled) setToc(flat);
      } catch {
        // toc is a nice-to-have — silent fail keeps the reader usable
      }
      try {
        await book.locations.generate(1024);
      } catch {
        // locations are required for accurate progress; readers without
        // them just see 0% throughout, which is acceptable
      }
    });

    rendition.on("relocated", (value: unknown) => {
      try {
        const loc = value as { start?: { cfi?: string } };
        const cfi = loc?.start?.cfi;
        if (!cfi) return;
        const pct = book.locations.percentageFromCfi(cfi);
        if (typeof pct === "number" && Number.isFinite(pct)) {
          setProgress(Math.round(pct * 100));
        }
      } catch {
        // pre-locations relocate events throw — ignore
      }
    });

    return () => {
      cancelled = true;
      try {
        rendition.destroy();
      } catch {
        // already destroyed
      }
      try {
        book.destroy();
      } catch {
        // already destroyed
      }
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [fileUrl, isDark]);

  function go(href: string) {
    renditionRef.current?.display(href);
    setTocOpen(false);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
        <button
          type="button"
          onClick={() => setTocOpen((v) => !v)}
          disabled={toc.length === 0}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
        >
          <List size={12} /> Contents
        </button>
        <span className="tabular-nums">{progress}%</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => renditionRef.current?.prev()}
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Previous"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => renditionRef.current?.next()}
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Next"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div className="relative">
        {tocOpen && toc.length > 0 && (
          <div className="absolute left-0 top-0 z-10 max-h-[70vh] w-72 overflow-y-auto border-b border-r border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {toc.map((t, i) => (
              <button
                key={`${t.href}-${i}`}
                onClick={() => go(t.href)}
                className="block w-full truncate rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {t.label || `Section ${i + 1}`}
              </button>
            ))}
          </div>
        )}
        {!ready && !loadError && (
          <div className="flex h-[70vh] items-center justify-center">
            <Spinner size={20} />
          </div>
        )}
        {loadError && (
          <div className="flex h-[70vh] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-rose-600 dark:text-rose-400">
            <AlertCircle size={18} />
            <div>Couldn&apos;t open the EPUB: {loadError}</div>
          </div>
        )}
        <div ref={containerRef} className={ready ? "" : "invisible h-0"} />
      </div>
    </div>
  );
}

// ─────────────────────────── Video content ─────────────────────────────

function VideoContent({ fileUrl }: { fileUrl: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-black shadow-sm dark:border-slate-700">
      <video src={fileUrl} controls className="h-auto w-full" />
    </div>
  );
}

// ─────────────────────────── URL content ───────────────────────────────

function UrlContent({
  resource,
  showRaw,
  onToggleRaw,
}: {
  resource: Resource;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const url = resource.sourceUrl ?? "";
  const host = hostnameOf(url);
  return (
    <div className="flex flex-col gap-4">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-700"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <ExternalLink size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Open original
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{host}</div>
        </div>
        <span className="text-xs font-medium text-indigo-600 group-hover:translate-x-0.5 transition dark:text-indigo-300">
          Visit ↗
        </span>
      </a>
      {resource.bodyText && (
        <div>
          <button
            type="button"
            onClick={onToggleRaw}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600"
          >
            <Eye size={12} />
            {showRaw ? "Hide extracted text" : "Show extracted text"}
          </button>
          {showRaw && (
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-5 font-sans text-sm leading-7 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              {resource.bodyText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── Extracted fallback ────────────────────────

function ExtractedFallback({ bodyText }: { bodyText: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-600"
      >
        <Eye size={12} />
        {open ? "Hide extracted text" : "Show extracted text"}
      </button>
      {open && (
        <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-5 font-sans text-sm leading-7 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          {bodyText}
        </pre>
      )}
    </div>
  );
}

// ─────────────────────────── Markdown helper ───────────────────────────

function Markdown({ body }: { body: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(body, {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return DOMPurify.sanitize(raw);
  }, [body]);
  return <div className="doc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─────────────────────────── Status badge ──────────────────────────────

function StatusBadge({ status }: { status: Resource["status"] }) {
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

// ─────────────────────────── Helpers ───────────────────────────────────

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ─────────────────────────── Share modal ──────────────────────────────

function ShareModal({
  open,
  company,
  resource,
  onClose,
  onChanged,
}: {
  open: boolean;
  company: Company;
  resource: Resource;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { toast, background } = useToast();
  const [grants, setGrants] = React.useState<ResourceGrant[]>([]);
  const [candidates, setCandidates] = React.useState<ResourceGrantCandidate[]>([]);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!open) return;
    try {
      const [g, cs] = await Promise.all([
        api.get<ResourceGrantsResponse>(
          `/api/companies/${company.id}/resources/${resource.slug}/grants`,
        ),
        api.get<ResourceGrantCandidate[]>(
          `/api/companies/${company.id}/resources/${resource.slug}/grant-candidates`,
        ),
      ]);
      setGrants(g.direct);
      setCandidates(cs);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [open, company.id, resource.slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function add(employeeId: string, accessLevel: ResourceAccessLevel) {
    setBusy(true);
    try {
      await api.post<ResourceGrant>(
        `/api/companies/${company.id}/resources/${resource.slug}/grants`,
        { employeeId, accessLevel },
      );
      await reload();
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  function changeLevel(grant: ResourceGrant, next: ResourceAccessLevel) {
    if (grant.accessLevel === next) return;
    setGrants((current) =>
      current.map((item) => (item.id === grant.id ? { ...item, accessLevel: next } : item)),
    );
    background(
      () =>
        api.patch(`/api/companies/${company.id}/resources/${resource.slug}/grants/${grant.id}`, {
          accessLevel: next,
        }),
      {
        loading: "Updating resource access…",
        error: (error) =>
          `Couldn\u2019t update access: ${
            error instanceof Error ? error.message : String(error)
          }. The change was undone.`,
        onSuccess: () => onChanged?.(),
        onError: () => {
          setGrants((current) => current.map((item) => (item.id === grant.id ? grant : item)));
        },
      },
    );
  }

  function remove(grantId: string) {
    const grant = grants.find((item) => item.id === grantId);
    if (!grant) return;
    const originalIndex = grants.findIndex((item) => item.id === grantId);
    setGrants((current) => current.filter((item) => item.id !== grantId));
    background(
      () => api.del(`/api/companies/${company.id}/resources/${resource.slug}/grants/${grantId}`),
      {
        loading: "Removing resource access…",
        success: "Resource access removed",
        error: (error) =>
          `Couldn\u2019t remove access: ${
            error instanceof Error ? error.message : String(error)
          }. The grant has been restored.`,
        onSuccess: () => onChanged?.(),
        onError: () => {
          setGrants((current) => {
            if (current.some((item) => item.id === grantId)) return current;
            const next = [...current];
            next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, grant);
            return next;
          });
        },
      },
    );
  }

  const ungranted = candidates.filter((c) => !c.alreadyGranted);

  return (
    <Modal open={open} onClose={onClose} title="Share with AI employees" size="lg">
      <div className="flex flex-col gap-5">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Pick what each AI employee can do with this resource through its MCP tools —{" "}
          <span className="font-medium">View only</span> reads it,{" "}
          <span className="font-medium">Can edit</span> also modifies it,{" "}
          <span className="font-medium">Can delete</span> can also remove it. Authors keep full
          control of the rows they create.
        </p>
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Has access</h3>
          {grants.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No employees have access. Add one below.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {grants.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
                      <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {g.employee?.name ?? "Unknown"}
                      </span>
                    </div>
                    <div className="ml-[18px] truncate text-xs text-slate-500 dark:text-slate-400">
                      {g.employee?.role ?? ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <AccessLevelMenu
                      level={g.accessLevel}
                      busy={busy}
                      onChange={(next) => changeLevel(g, next)}
                    />
                    <button
                      type="button"
                      onClick={() => remove(g.id)}
                      disabled={busy}
                      title="Revoke access"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Add an employee
          </h3>
          {ungranted.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Every AI employee in this company already has access.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {ungranted.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {c.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {c.role}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => add(c.id, "read")}
                      disabled={busy}
                    >
                      <Plus size={12} /> View
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => add(c.id, "edit")}
                      disabled={busy}
                    >
                      <Plus size={12} /> Edit
                    </Button>
                    <Button size="sm" onClick={() => add(c.id, "delete")} disabled={busy}>
                      <Plus size={12} /> Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AccessLevelMenu({
  level,
  busy,
  onChange,
}: {
  level: ResourceAccessLevel;
  busy: boolean;
  onChange: (next: ResourceAccessLevel) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const options: {
    value: ResourceAccessLevel;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }[] = [
    {
      value: "read",
      label: "View only",
      hint: "Can list, search, and read",
      icon: <Eye size={14} />,
    },
    {
      value: "edit",
      label: "Can edit",
      hint: "Also modifies title, body, tags",
      icon: <Pencil size={14} />,
    },
    {
      value: "delete",
      label: "Can delete",
      hint: "Also removes the resource",
      icon: <Trash2 size={14} />,
    },
  ];
  const current = options.find((o) => o.value === level) ?? options[0];
  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700"
      >
        {current.label}
        <ChevronDown size={12} className="text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                className={
                  "flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 " +
                  (level === o.value
                    ? "text-indigo-600 dark:text-indigo-300"
                    : "text-slate-700 dark:text-slate-200")
                }
              >
                <span className="mt-0.5">{o.icon}</span>
                <span className="flex-1">
                  <span className="block">{o.label}</span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    {o.hint}
                  </span>
                </span>
                {level === o.value && <Check size={12} className="mt-1 shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
