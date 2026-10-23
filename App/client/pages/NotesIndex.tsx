import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { BookPlus, FilePlus, Search, Sparkles, X } from "lucide-react";
import { api, Company, NoteSearchHit } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { recentNotes } from "../lib/noteTree";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { NoteIcon, formatRelative } from "../components/notes/NoteIcon";
import type { NotesContext } from "./NotesLayout";

/**
 * Notes home (`/c/<co>/notes`): search every page, jump back into what was
 * edited last, browse notebooks — and, before there's anything, learn how
 * notes work and make the first page.
 */
export default function NotesIndex({ company }: { company: Company }) {
  const ctx = useOutletContext<NotesContext>();
  const { notebooks, notes, loading } = ctx;
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<NoteSearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    setSearchError(null);
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        setResults(
          await api.get<NoteSearchHit[]>(
            `/api/companies/${company.id}/notes/search?view=outline&q=${encodeURIComponent(q)}`,
          ),
        );
      } catch (err) {
        setSearchError(errorMessage(err, "Could not search these notes"));
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, company.id]);

  const recents = React.useMemo(() => recentNotes(notes, 6), [notes]);
  const notebookById = React.useMemo(() => new Map(notebooks.map((nb) => [nb.id, nb])), [notebooks]);
  const pageCount = (notebookId: string) => notes.filter((n) => n.notebookId === notebookId).length;
  const empty = !loading && notes.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-5 pb-20 pt-10 sm:px-10 sm:pt-14">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Notes</h1>
              <p className="mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                Pages your team and your AI Employees write together — runbooks, briefs, plans, meeting notes.
              </p>
            </div>
            <Button
              onClick={() => void ctx.createPage({ key: "home" })}
              loading={ctx.creating === "home"}
              disabled={ctx.creating !== null && ctx.creating !== "home"}
            >
              <FilePlus size={15} /> New page
            </Button>
          </div>

          {!empty && (
            <div className="relative mb-8">
              <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search every page…"
                aria-label="Search every page"
                className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-9 text-[15px] text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}

          {searchError ? (
            <FormError message={searchError} />
          ) : results !== null || searching ? (
            <SearchResults
              results={results ?? []}
              query={query.trim()}
              searching={searching}
              hrefFor={ctx.hrefFor}
              notebookTitle={(id) => notebookById.get(id)?.title ?? ""}
            />
          ) : loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : empty ? (
            <EmptyHero onCreate={() => void ctx.createPage({ key: "hero" })} creating={ctx.creating === "hero"} />
          ) : (
            <>
              {recents.length > 0 && (
                <section aria-label="Recently edited" className="mb-10">
                  <h2 className="mb-3 text-xs font-medium text-slate-500 dark:text-slate-400">Recently edited</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {recents.map((note) => {
                      const who = note.lastEditedBy ?? note.createdBy;
                      return (
                        <Link
                          key={note.id}
                          to={ctx.hrefFor(note)}
                          className="group flex min-h-[7.5rem] flex-col rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
                        >
                          <span className="mb-2 flex h-6 items-center">
                            <NoteIcon icon={note.icon} size={18} />
                          </span>
                          <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {note.title || "Untitled"}
                          </span>
                          {note.preview && (
                            <span className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{note.preview}</span>
                          )}
                          <span className="mt-auto pt-2 text-[11px] text-slate-400 dark:text-slate-500">
                            {formatRelative(note.updatedAt)}
                            {who ? ` · ${who.name}` : ""}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              )}

              <section aria-label="Notebooks">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-medium text-slate-500 dark:text-slate-400">Notebooks</h2>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void ctx.createNotebook()}
                    loading={ctx.creating === "notebook"}
                    disabled={ctx.creating !== null && ctx.creating !== "notebook"}
                  >
                    <BookPlus size={14} /> New notebook
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {notebooks.map((nb) => {
                    const count = pageCount(nb.id);
                    return (
                      <Link
                        key={nb.id}
                        to={`/c/${company.slug}/notes/${nb.slug}`}
                        className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800">
                          <NoteIcon icon={nb.icon} kind="notebook" size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {nb.title || "Untitled notebook"}
                          </span>
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            {count === 0 ? "No pages yet" : `${count} page${count === 1 ? "" : "s"}`}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SearchResults({
  results,
  query,
  searching,
  hrefFor,
  notebookTitle,
}: {
  results: NoteSearchHit[];
  query: string;
  searching: boolean;
  hrefFor: (note: { slug: string; notebookId: string }) => string;
  notebookTitle: (id: string) => string;
}) {
  if (searching && results.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-slate-500 dark:text-slate-400">
        <Spinner size={14} /> Searching for &ldquo;{query}&rdquo;…
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 px-6 py-10 text-center dark:border-slate-700">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">No pages match &ldquo;{query}&rdquo;</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Search looks at titles and page text. Try fewer or different words.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {results.map((hit) => (
        <li key={hit.id}>
          <Link to={hrefFor(hit)} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
              <NoteIcon icon={hit.icon} size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{hit.title || "Untitled"}</span>
              {hit.snippet && (
                <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500 dark:text-slate-400">{hit.snippet}</span>
              )}
            </span>
            <span className="hidden shrink-0 text-right text-[11px] text-slate-400 sm:block dark:text-slate-500">
              {notebookTitle(hit.notebookId)}
              <br />
              {formatRelative(hit.updatedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function EmptyHero({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center sm:px-10 dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
        <Sparkles size={22} />
      </div>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Write it down once, for everyone</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
        A note is a page anyone in the company can read and edit — and AI Employees too, once you share it with them.
      </p>
      <ul className="mx-auto mt-6 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
        {[
          ["Type /", "for headings, to-dos, toggles, callouts, code and more."],
          ["Use Markdown", "as you type: # for a heading, - for a list, [] for a to-do."],
          ["Nest pages", "inside pages and drag them around in the sidebar."],
        ].map(([lead, rest]) => (
          <li key={lead} className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <span className="font-semibold text-slate-800 dark:text-slate-100">{lead}</span> {rest}
          </li>
        ))}
      </ul>
      <Button className="mt-6" onClick={onCreate} loading={creating}>
        <FilePlus size={15} /> Create your first page
      </Button>
    </div>
  );
}
