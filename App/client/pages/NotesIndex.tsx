import React from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  Book,
  BookPlus,
  Clock,
  FileText,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { api, Company, Note, Notebook } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { NotesContext } from "./NotesLayout";
import { clsx } from "../components/ui/clsx";

/**
 * Notes welcome screen. Shown when the URL is /c/<slug>/notes with no
 * notebook or note selected. Lists every notebook with its activity, plus
 * a global search bar that hits the LIKE-search endpoint across all
 * notebooks.
 */
export default function NotesIndex({ company }: { company: Company }) {
  const { notebooks, notes, refresh } = useOutletContext<NotesContext>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Note[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [creatingNb, setCreatingNb] = React.useState(false);

  React.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const rows = await api.get<Note[]>(
          `/api/companies/${company.id}/notes/search?q=${encodeURIComponent(q)}`,
        );
        setResults(rows);
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, company.id, toast]);

  const notebookById = React.useMemo(() => {
    const m = new Map<string, Notebook>();
    for (const nb of notebooks) m.set(nb.id, nb);
    return m;
  }, [notebooks]);

  async function createNotebook() {
    setCreatingNb(true);
    try {
      const title = await dialog.prompt({
        title: "New notebook",
        message: "Notebooks group related pages — runbooks, briefs, post-mortems, etc.",
        placeholder: "Notebook name",
        confirmLabel: "Create",
      });
      if (!title) return;
      const created = await api.post<Notebook>(
        `/api/companies/${company.id}/notebooks`,
        { title },
      );
      await refresh();
      navigate(`/c/${company.slug}/notes/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreatingNb(false);
    }
  }

  const live = notes.filter((n) => n.archivedAt === null);
  const recents = React.useMemo(
    () =>
      [...live]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, 8),
    [live],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Notes" },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pt-12">
          <div className="mb-8">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Notes
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {company.name}
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Shared knowledge for humans and AI employees. Group related pages
              into notebooks — runbooks, briefs, post-mortems — and nest pages
              underneath when they belong together.
            </p>
          </div>

          <div className="relative mb-8">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages across every notebook…"
              className="w-full rounded-lg border border-slate-200 bg-white py-3 pl-11 pr-4 text-base text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
          </div>

          {results !== null ? (
            <SearchResults
              company={company}
              query={query}
              results={results}
              searching={searching}
              notebookById={notebookById}
            />
          ) : notebooks.length === 0 ? (
            <EmptyHero onCreate={createNotebook} creating={creatingNb} />
          ) : (
            <>
              <NotebookGrid
                company={company}
                notebooks={notebooks}
                notes={live}
                onCreate={createNotebook}
                creating={creatingNb}
              />
              {recents.length > 0 && (
                <div className="mt-10">
                  <RecentList
                    company={company}
                    notes={recents}
                    notebookById={notebookById}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyHero({
  onCreate,
  creating,
}: {
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white px-8 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
        <Sparkles size={22} />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Start your first notebook
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Notebooks hold related pages. Create one for your company handbook,
        another for product briefs — anything you want everyone to be able to
        read and edit.
      </p>
      <button
        onClick={onCreate}
        disabled={creating}
        className="mx-auto mt-5 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        <BookPlus size={14} /> {creating ? "Creating…" : "Create your first notebook"}
      </button>
    </div>
  );
}

function NotebookGrid({
  company,
  notebooks,
  notes,
  onCreate,
  creating,
}: {
  company: Company;
  notebooks: Notebook[];
  notes: Note[];
  onCreate: () => void;
  creating: boolean;
}) {
  // Most recent updatedAt across the notebook's live notes — the same
  // signal that drives the "Recently edited" feed.
  const lastTouchByNotebook = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      const t = new Date(n.updatedAt).getTime();
      const cur = m.get(n.notebookId) ?? 0;
      if (t > cur) m.set(n.notebookId, t);
    }
    return m;
  }, [notes]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Notebooks
        </div>
        <button
          onClick={onCreate}
          disabled={creating}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
        >
          <BookPlus size={12} /> {creating ? "Creating…" : "New notebook"}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {notebooks.map((nb) => (
          <NotebookCard
            key={nb.id}
            company={company}
            notebook={nb}
            lastTouch={lastTouchByNotebook.get(nb.id) ?? 0}
          />
        ))}
      </div>
    </div>
  );
}

function NotebookCard({
  company,
  notebook,
  lastTouch,
}: {
  company: Company;
  notebook: Notebook;
  lastTouch: number;
}) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(`/c/${company.slug}/notes/${notebook.slug}`)}
      className="group flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-700"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-lg dark:bg-slate-800">
          {notebook.icon ? (
            <span aria-hidden>{notebook.icon}</span>
          ) : (
            <Book size={16} className="text-slate-500 dark:text-slate-400" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {notebook.title || "Untitled notebook"}
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {notebook.noteCount === 0
              ? "No pages yet"
              : `${notebook.noteCount} page${notebook.noteCount === 1 ? "" : "s"}`}
            {lastTouch > 0
              ? ` · updated ${formatRelative(new Date(lastTouch).toISOString())}`
              : ""}
          </div>
        </div>
      </div>
    </button>
  );
}

function RecentList({
  company,
  notes,
  notebookById,
}: {
  company: Company;
  notes: Note[];
  notebookById: Map<string, Notebook>;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Clock size={12} />
        Recently edited
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        {notes.map((n, i) => (
          <NoteListRow
            key={n.id}
            company={company}
            note={n}
            notebook={notebookById.get(n.notebookId) ?? null}
            isLast={i === notes.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function NoteListRow({
  company,
  note,
  notebook,
  isLast,
}: {
  company: Company;
  note: Note;
  notebook: Notebook | null;
  isLast: boolean;
}) {
  const navigate = useNavigate();
  const editor = note.lastEditedBy?.name ?? note.createdBy?.name ?? "Unknown";
  const editorKind = note.lastEditedBy?.kind ?? note.createdBy?.kind ?? null;
  return (
    <button
      onClick={() =>
        navigate(
          `/c/${company.slug}/notes/${notebook?.slug ?? ""}/${note.slug}`,
        )
      }
      className={clsx(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60",
        !isLast && "border-b border-slate-100 dark:border-slate-800",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-base dark:bg-slate-800">
        {note.icon ? (
          <span aria-hidden>{note.icon}</span>
        ) : (
          <FileText size={14} className="text-slate-500 dark:text-slate-400" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {note.title || "Untitled"}
        </div>
        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
          {notebook ? (
            <span className="mr-2 inline-flex items-center gap-1 text-slate-400 dark:text-slate-500">
              <Book size={10} /> {notebook.title}
            </span>
          ) : null}
          {note.body && previewBody(note.body)}
        </div>
      </div>
      <div className="hidden shrink-0 text-right text-xs text-slate-400 dark:text-slate-500 sm:block">
        <div>{formatRelative(note.updatedAt)}</div>
        <div className="truncate text-[11px]">
          {editorKind === "ai" ? "AI · " : ""}
          {editor}
        </div>
      </div>
    </button>
  );
}

function previewBody(body: string): string {
  return body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function formatRelative(ts: string): string {
  const then = new Date(ts).getTime();
  const diff = Date.now() - then;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function SearchResults({
  company,
  query,
  results,
  searching,
  notebookById,
}: {
  company: Company;
  query: string;
  results: Note[];
  searching: boolean;
  notebookById: Map<string, Notebook>;
}) {
  const navigate = useNavigate();
  if (searching && results.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Searching for &quot;{query}&quot;…
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          No matches
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Nothing found for &quot;{query}&quot;. Try a different keyword.
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      {results.map((n, i) => {
        const nb = notebookById.get(n.notebookId);
        return (
          <button
            key={n.id}
            onClick={() =>
              navigate(`/c/${company.slug}/notes/${nb?.slug ?? ""}/${n.slug}`)
            }
            className={
              "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 " +
              (i > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
            }
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-base dark:bg-slate-800">
              {n.icon ? (
                <span aria-hidden>{n.icon}</span>
              ) : (
                <FileText size={14} className="text-slate-500 dark:text-slate-400" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {n.title || "Untitled"}
              </div>
              {nb && (
                <div className="mb-0.5 inline-flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
                  <Book size={10} /> {nb.title}
                </div>
              )}
              {n.body && (
                <div className="line-clamp-1 text-xs text-slate-500 dark:text-slate-400">
                  {snippetAround(n.body, query)}
                </div>
              )}
            </div>
            <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
              {new Date(n.updatedAt).toLocaleDateString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function snippetAround(body: string, query: string): string {
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return body.slice(0, 160);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + query.length + 80);
  const prefix = start === 0 ? "" : "…";
  const suffix = end === body.length ? "" : "…";
  return prefix + body.slice(start, end) + suffix;
}

// Re-export Plus so other modules importing from this file keep working.
export { Plus };
