import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { FilePlus, MoreHorizontal, Search, Share2, SmilePlus, Trash2, X } from "lucide-react";
import { api, Company, Notebook, NoteSearchHit } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { buildNoteTree, descendantIds } from "../lib/noteTree";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem } from "../components/ui/Menu";
import { RecordHistory } from "../components/RecordHistory";
import { AsyncResourceTagPicker } from "../components/TagPicker";
import { IconPicker, NoteIcon, formatRelative } from "../components/notes/NoteIcon";
import { NotebookShareModal } from "../components/notes/NotebookShareModal";
import type { NotesContext } from "./NotesLayout";

/**
 * A notebook's own page: its name and icon (click to change either), its
 * pages in their sidebar order with a line of each, search within it, and
 * sharing with AI Employees.
 */
export default function NotebookDetail({ company }: { company: Company }) {
  const { notebookSlug } = useParams<{ notebookSlug: string }>();
  const ctx = useOutletContext<NotesContext>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const notebook = ctx.notebooks.find((nb) => nb.slug === notebookSlug) ?? null;
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<NoteSearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [iconOpen, setIconOpen] = React.useState(false);
  const [title, setTitle] = React.useState(notebook?.title ?? "");
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const iconRef = React.useRef<HTMLButtonElement>(null);
  const base = `/api/companies/${company.id}`;

  const notebookTitle = notebook?.title;
  React.useEffect(() => {
    if (notebookTitle !== undefined) setTitle(notebookTitle);
  }, [notebookTitle]);

  React.useEffect(() => {
    const q = query.trim();
    setSearchError(null);
    if (!q || !notebookSlug) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        setHits(
          await api.get<NoteSearchHit[]>(
            `${base}/notes/search?view=outline&notebookSlug=${encodeURIComponent(notebookSlug)}&q=${encodeURIComponent(q)}`,
          ),
        );
      } catch (err) {
        setSearchError(errorMessage(err, "Could not search this notebook"));
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, base, notebookSlug]);

  const tree = React.useMemo(() => buildNoteTree(ctx.notes).get(notebook?.id ?? "") ?? [], [ctx.notes, notebook?.id]);

  if (!notebook) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-slate-500 dark:text-slate-400">
        {ctx.loading ? (
          <Spinner />
        ) : (
          <div className="text-center">
            <p>This notebook doesn&apos;t exist, or was deleted.</p>
            <Link to={`/c/${company.slug}/notes`} className="mt-2 inline-block text-indigo-600 hover:underline dark:text-indigo-300">
              Back to Notes
            </Link>
          </div>
        )}
      </div>
    );
  }

  async function saveNotebook(patch: Partial<Pick<Notebook, "title" | "icon">>) {
    if (!notebook) return;
    try {
      await api.patch<Notebook>(`${base}/notebooks/${notebook.slug}`, patch);
      setTitleError(null);
      await ctx.refresh();
    } catch (err) {
      if (patch.title !== undefined) setTitleError(errorMessage(err, "Couldn't rename the notebook"));
      else void dialog.error(err, { title: "Couldn’t change the icon" });
    }
  }

  async function commitTitle() {
    if (!notebook) return;
    const next = title.trim();
    if (!next) {
      setTitle(notebook.title);
      return;
    }
    if (next !== notebook.title) await saveNotebook({ title: next });
  }

  async function deleteNotebook() {
    if (!notebook) return;
    const live = notebook.noteCount;
    const trashed = notebook.archivedCount;
    const parts: string[] = [];
    if (live > 0) parts.push(`${live} page${live === 1 ? "" : "s"}`);
    if (trashed > 0) parts.push(`${trashed} trashed page${trashed === 1 ? "" : "s"}`);
    const ok = await dialog.confirm({
      title: `Delete the notebook “${notebook.title}”?`,
      message: parts.length
        ? `This permanently deletes it and ${parts.join(" and ")}. This can't be undone.`
        : "The notebook is empty. This can't be undone.",
      confirmLabel: "Delete notebook",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/notebooks/${notebook.slug}`);
      await ctx.refresh();
      navigate(`/c/${company.slug}/notes`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the notebook" });
    }
  }

  const creatingHere = ctx.creating === `notebook:${notebook.id}`;

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 flex h-11 items-center justify-between gap-2 border-b border-slate-100 bg-white/90 px-3 backdrop-blur sm:px-4 dark:border-slate-800 dark:bg-slate-950/85">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-slate-500 dark:text-slate-400">
          <Link to={`/c/${company.slug}/notes`} className="rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100">
            Notes
          </Link>
          <span aria-hidden className="text-slate-300 dark:text-slate-600">/</span>
          <span className="flex min-w-0 items-center gap-1 px-1 font-medium text-slate-700 dark:text-slate-200">
            <NoteIcon icon={notebook.icon} kind="notebook" size={13} />
            <span className="truncate">{notebook.title}</span>
          </span>
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Share the whole notebook with AI Employees"
          >
            <Share2 size={14} />
            <span className="hidden sm:inline">Share</span>
          </button>
          <Menu
            align="right"
            width={210}
            trigger={({ ref, onClick, open }) => (
              <button
                ref={ref}
                type="button"
                onClick={onClick}
                aria-label="Notebook actions"
                aria-expanded={open}
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <MoreHorizontal size={16} />
              </button>
            )}
          >
            {(close) => (
              <MenuItem
                icon={<Trash2 size={14} />}
                label="Delete notebook"
                className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                onSelect={() => {
                  close();
                  void deleteNotebook();
                }}
              />
            )}
          </Menu>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 sm:px-10 sm:pt-14">
          <div className="group/title mb-2 flex items-start gap-3">
            <div className="relative">
              <button
                ref={iconRef}
                type="button"
                onClick={() => setIconOpen((v) => !v)}
                aria-label={notebook.icon ? "Change icon" : "Add icon"}
                className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-100 text-3xl hover:bg-slate-200/70 dark:bg-slate-800 dark:hover:bg-slate-700"
              >
                {notebook.icon ? <span aria-hidden>{notebook.icon}</span> : <SmilePlus size={20} className="text-slate-400" />}
              </button>
              {iconOpen && (
                <IconPicker
                  kind="notebook"
                  current={notebook.icon}
                  onPick={(icon) => {
                    setIconOpen(false);
                    void saveNotebook({ icon });
                  }}
                  onRemove={() => {
                    setIconOpen(false);
                    void saveNotebook({ icon: "" });
                  }}
                  onClose={() => setIconOpen(false)}
                  triggerRef={iconRef}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setTitle(notebook.title);
                    event.currentTarget.blur();
                  }
                }}
                maxLength={80}
                aria-label="Notebook name"
                className="w-full rounded-md border-0 bg-transparent px-0 py-0 text-3xl font-bold tracking-tight text-slate-900 focus:outline-none focus:ring-0 dark:text-slate-50"
              />
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {notebook.noteCount === 0 ? "No pages yet" : `${notebook.noteCount} page${notebook.noteCount === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>
          <FormError message={titleError} className="mb-2" />

          <div className="mb-6 mt-2">
            <AsyncResourceTagPicker
              companyId={company.id}
              resourceType="notebook"
              resourceId={notebook.id}
              variant="inline"
            />
          </div>

          <div className="mb-6 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search this notebook…"
                aria-label="Search this notebook"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-8 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <Button
              onClick={() => void ctx.createPage({ notebook })}
              loading={creatingHere}
              disabled={ctx.creating !== null && !creatingHere}
            >
              <FilePlus size={15} /> New page
            </Button>
          </div>

          {query.trim() ? (
            searchError ? (
              <FormError message={searchError} />
            ) : searching && !hits ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-500"><Spinner size={14} /> Searching…</div>
            ) : (hits ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Nothing in this notebook matches &ldquo;{query.trim()}&rdquo;.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {(hits ?? []).map((hit) => (
                  <li key={hit.id}>
                    <Link to={ctx.hrefFor(hit)} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <span className="mt-0.5 flex h-5 w-5 items-center justify-center"><NoteIcon icon={hit.icon} size={15} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{hit.title || "Untitled"}</span>
                        {hit.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500 dark:text-slate-400">{hit.snippet}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          ) : tree.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-8 py-12 text-center dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">This notebook is empty</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
                Add a page for a runbook, a decision, a brief — anything the team should be able to find again.
              </p>
              <Button className="mt-4" onClick={() => void ctx.createPage({ notebook, key: "notebook-empty" })} loading={ctx.creating === "notebook-empty"}>
                <FilePlus size={15} /> Create the first page
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {tree.map(({ note }) => {
                const inside = descendantIds(ctx.notes, note.id).size;
                const who = note.lastEditedBy ?? note.createdBy;
                return (
                  <li key={note.id}>
                    <Link to={ctx.hrefFor(note)} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center"><NoteIcon icon={note.icon} size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{note.title || "Untitled"}</span>
                        {note.preview && <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">{note.preview}</span>}
                      </span>
                      <span className="hidden shrink-0 text-right text-[11px] text-slate-400 sm:block dark:text-slate-500">
                        {formatRelative(note.updatedAt)}
                        {who ? ` · ${who.name}` : ""}
                        {inside > 0 && <><br />{inside} page{inside === 1 ? "" : "s"} inside</>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          <RecordHistory
            className="mt-10"
            companyId={company.id}
            companySlug={company.slug}
            targetType="notebook"
            targetId={notebook.id}
            noun="this notebook"
            milestones={[{ label: "Notebook created", at: notebook.createdAt, covers: ["create"] }]}
          />
        </div>
      </div>

      <NotebookShareModal company={company} notebook={notebook} open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}
