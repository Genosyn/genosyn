import React from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  Clock,
  FileText,
  PenLine,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { api, Company, Note } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { NotesContext } from "./NotesLayout";
import { clsx } from "../components/ui/clsx";

/**
 * Notes welcome screen. Shown when the URL is /c/<slug>/notes with no note
 * selected. Doubles as the search surface — typing into the hero input hits
 * the LIKE-search endpoint and renders matches inline.
 */
export default function NotesIndex({ company }: { company: Company }) {
  const { notes, refresh } = useOutletContext<NotesContext>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Note[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

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

  async function createTopLevel() {
    setCreating(true);
    try {
      const created = await api.post<Note>(`/api/companies/${company.id}/notes`, {
        title: "Untitled",
      });
      await refresh();
      navigate(`/c/${company.slug}/notes/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreating(false);
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
          {/* Hero — title with the same emphasis a note's title gets, then a
              big search/jumper. No card chrome on the search; it should feel
              like the search bar is the page. */}
          <div className="mb-8">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Notes
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {company.name}
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Shared knowledge for humans and AI employees. Write a runbook,
              capture a decision, link a brief — anything you want everyone to
              be able to read and edit.
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
              placeholder="Search pages or jump to one…"
              className="w-full rounded-lg border border-slate-200 bg-white py-3 pl-11 pr-4 text-base text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
            <button
              onClick={createTopLevel}
              disabled={creating}
              className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
            >
              <Plus size={13} /> {creating ? "Creating…" : "New"}
            </button>
          </div>

          {results !== null ? (
            <SearchResults
              company={company}
              query={query}
              results={results}
              searching={searching}
            />
          ) : live.length === 0 ? (
            <EmptyHero onCreate={createTopLevel} creating={creating} />
          ) : (
            <RecentList company={company} notes={recents} />
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
        Start your first page
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Type{" "}
        <kbd className="rounded border border-slate-300 bg-slate-100 px-1 py-0.5 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
          /
        </kbd>{" "}
        anywhere on a page to insert headings, lists, to-dos and more. AI
        employees can read and write notes you share with them.
      </p>
      <button
        onClick={onCreate}
        disabled={creating}
        className="mx-auto mt-5 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        <PenLine size={14} /> {creating ? "Creating…" : "Create your first page"}
      </button>
    </div>
  );
}

function RecentList({ company, notes }: { company: Company; notes: Note[] }) {
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
  isLast,
}: {
  company: Company;
  note: Note;
  isLast: boolean;
}) {
  const navigate = useNavigate();
  const editor = note.lastEditedBy?.name ?? note.createdBy?.name ?? "Unknown";
  const editorKind = note.lastEditedBy?.kind ?? note.createdBy?.kind ?? null;
  return (
    <button
      onClick={() => navigate(`/c/${company.slug}/notes/${note.slug}`)}
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
        {note.body && (
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {previewBody(note.body)}
          </div>
        )}
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
}: {
  company: Company;
  query: string;
  results: Note[];
  searching: boolean;
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
      {results.map((n, i) => (
        <button
          key={n.id}
          onClick={() => navigate(`/c/${company.slug}/notes/${n.slug}`)}
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
      ))}
    </div>
  );
}

/**
 * Pull a short snippet from `body` centered on the first occurrence of
 * `query` (case-insensitive). Falls back to the body's leading characters
 * if there's no match — which can happen when the hit was on the title.
 */
function snippetAround(body: string, query: string): string {
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return body.slice(0, 160);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + query.length + 80);
  const prefix = start === 0 ? "" : "…";
  const suffix = end === body.length ? "" : "…";
  return prefix + body.slice(start, end) + suffix;
}
