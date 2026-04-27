import React from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { FileText, Plus, Search } from "lucide-react";
import { api, Company, Note } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EmptyState } from "../components/ui/EmptyState";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { NotesContext } from "./NotesLayout";

/**
 * Notes welcome screen. Shown when the URL is /c/<slug>/notes with no note
 * selected. Doubles as the search surface — typing into the search box hits
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

  const recents = React.useMemo(
    () =>
      [...notes]
        .filter((n) => n.archivedAt === null)
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, 6),
    [notes],
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Breadcrumbs
        items={[
          { label: company.name, to: `/c/${company.slug}` },
          { label: "Notes" },
        ]}
      />
      <TopBar
        title="Notes"
        right={
          <Button onClick={createTopLevel} disabled={creating}>
            <Plus size={14} /> {creating ? "Creating…" : "New note"}
          </Button>
        }
      />

      <div className="relative mb-6">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes by title or content…"
          className="pl-9"
        />
      </div>

      {results !== null ? (
        <SearchResults
          company={company}
          query={query}
          results={results}
          searching={searching}
        />
      ) : notes.filter((n) => !n.archivedAt).length === 0 ? (
        <EmptyState
          title="No notes yet"
          description="Notes are a Notion-style markdown knowledge base shared across humans and AI employees. Start a note for project context, runbooks, design decisions, or anything you'd like everyone — including the AI — to be able to read and write."
          action={
            <Button onClick={createTopLevel} disabled={creating}>
              <Plus size={14} />{" "}
              {creating ? "Creating…" : "Create your first note"}
            </Button>
          }
        />
      ) : (
        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Recently edited
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {recents.map((n) => (
              <NoteCard key={n.id} company={company} note={n} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NoteCard({ company, note }: { company: Company; note: Note }) {
  const navigate = useNavigate();
  const editor =
    note.lastEditedBy?.name ?? note.createdBy?.name ?? "Unknown";
  const editorKind =
    note.lastEditedBy?.kind ?? note.createdBy?.kind ?? null;
  return (
    <button
      onClick={() => navigate(`/c/${company.slug}/notes/${note.slug}`)}
      className="group block rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-indigo-300 hover:shadow dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center text-base">
          {note.icon || <FileText size={14} className="text-indigo-600" />}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-slate-100">
          {note.title || "Untitled"}
        </span>
      </div>
      {note.body && (
        <div className="mt-1 line-clamp-2 text-sm text-slate-500 dark:text-slate-400">
          {note.body.slice(0, 200)}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span>
          {editorKind === "ai" ? "Last edited by AI " : "Last edited by "}
          <span className="font-medium text-slate-700 dark:text-slate-300">
            {editor}
          </span>
        </span>
        <span>· {new Date(note.updatedAt).toLocaleDateString()}</span>
      </div>
    </button>
  );
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
      <EmptyState
        title="No matches"
        description={`Nothing found for "${query}". Try a different keyword.`}
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {results.map((n, i) => (
        <button
          key={n.id}
          onClick={() => navigate(`/c/${company.slug}/notes/${n.slug}`)}
          className={
            "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 " +
            (i > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
          }
        >
          <span className="mt-0.5 flex h-5 w-5 items-center justify-center text-sm">
            {n.icon || <FileText size={14} className="text-slate-400" />}
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
          <span className="text-xs text-slate-400 dark:text-slate-500">
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
