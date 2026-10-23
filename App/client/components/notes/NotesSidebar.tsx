import React from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  CopyPlus,
  CornerUpRight,
  FilePlus,
  Link2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { api, type Company, type Notebook, type NoteOutline, type NoteSearchHit } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { errorMessage } from "../../lib/errors";
import {
  ancestorIds,
  buildNoteTree,
  dropTarget,
  dropZoneAt,
  type DropZone,
  expandedKey,
  findNotesByTitle,
  notebookDropTarget,
  readExpanded,
  recentNotes,
  type TreeNode,
  writeExpanded,
} from "../../lib/noteTree";
import { browserStorage } from "../../lib/noteDrafts";
import { clsx } from "../ui/clsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { ButtonSpinner, Spinner } from "../ui/Spinner";
import { FormError } from "../ui/FormError";
import { useDialog } from "../ui/Dialog";
import type { NotesContext } from "../../pages/NotesLayout";
import { formatRelative, NoteIcon } from "./NoteIcon";

const DRAG_TYPE = "application/x-genosyn-note-id";

/**
 * The Notes sidebar: quick find, a new-page button, recently edited pages,
 * and every notebook's page tree — expand, drag to reorder or nest, and a
 * menu per page. The trash opens in place.
 */
export function NotesSidebar({
  company,
  context,
  loadError,
}: {
  company: Company;
  context: NotesContext;
  loadError: string | null;
}) {
  const [view, setView] = React.useState<"tree" | "trash">("tree");
  return view === "trash" ? (
    <TrashPanel company={company} context={context} onBack={() => setView("tree")} />
  ) : (
    <TreePanel company={company} context={context} loadError={loadError} onOpenTrash={() => setView("trash")} />
  );
}

function useExpanded(companyId: string) {
  const key = expandedKey(companyId);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => readExpanded(browserStorage(), key) ?? new Set());
  const toggle = React.useCallback(
    (id: string, open?: boolean) => {
      setExpanded((current) => {
        const next = new Set(current);
        const shouldOpen = open ?? !next.has(id);
        if (shouldOpen) next.add(id);
        else next.delete(id);
        writeExpanded(browserStorage(), key, next);
        return next;
      });
    },
    [key],
  );
  return { expanded, toggle };
}

function TreePanel({
  company,
  context,
  loadError,
  onOpenTrash,
}: {
  company: Company;
  context: NotesContext;
  loadError: string | null;
  onOpenTrash: () => void;
}) {
  const { notebooks, notes, loading, createPage, creating, createNotebook } = context;
  const location = useLocation();
  const { expanded, toggle } = useExpanded(company.id);
  const [query, setQuery] = React.useState("");

  const activeSlug = /\/notes\/[^/]+\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
  const active = activeSlug ? notes.find((n) => n.slug === activeSlug) ?? null : null;
  const tree = React.useMemo(() => buildNoteTree(notes), [notes]);
  const recents = React.useMemo(() => recentNotes(notes, 4), [notes]);

  // Opening a page reveals it: its notebook and every ancestor expand.
  const activeId = active?.id;
  const activeNotebookId = active?.notebookId;
  React.useEffect(() => {
    if (!activeId || !activeNotebookId) return;
    if (expanded.has(`collapsed:${activeNotebookId}`)) toggle(`collapsed:${activeNotebookId}`, false);
    for (const id of ancestorIds(notes, activeId)) if (!expanded.has(id)) toggle(id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeNotebookId]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3">
        <div className="mb-2 flex items-center justify-between pl-1">
          <Link
            to={`/c/${company.slug}/notes`}
            className="rounded px-1 py-0.5 text-sm font-semibold text-slate-800 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            Notes
          </Link>
          <button
            type="button"
            onClick={() => void createPage({ key: "quick" })}
            disabled={creating !== null}
            title="New page"
            aria-label="New page"
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            {creating === "quick" ? <ButtonSpinner size={15} /> : <SquarePen size={15} />}
          </button>
        </div>
        <QuickFind company={company} context={context} query={query} onQuery={setQuery} />
      </div>

      <nav aria-label="Notes" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loadError && <FormError message={loadError} className="mx-1 mb-2" />}
        {query.trim() ? null : loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-400">
            <Spinner size={12} /> Loading…
          </div>
        ) : (
          <>
            {recents.length > 0 && notes.length > 3 && (
              <section aria-label="Recently edited" className="mb-3">
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[11px] font-medium text-slate-400 dark:text-slate-500">
                  <Clock size={11} /> Recent
                </div>
                {recents.map((note) => (
                  <FlatRow key={note.id} note={note} href={context.hrefFor(note)} />
                ))}
              </section>
            )}
            <section aria-label="Notebooks">
              <div className="group/head flex items-center justify-between px-2 pb-1 pt-1">
                <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">Notebooks</span>
                <button
                  type="button"
                  onClick={() => void createNotebook()}
                  disabled={creating !== null}
                  title="New notebook"
                  aria-label="New notebook"
                  className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  {creating === "notebook" ? <ButtonSpinner size={12} /> : <Plus size={13} />}
                </button>
              </div>
              {notebooks.length === 0 ? (
                <div className="mx-1 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center dark:border-slate-700">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Notes live in notebooks. Start with a page — a notebook called General is made for it.
                  </p>
                  <button
                    type="button"
                    onClick={() => void createPage({ key: "empty" })}
                    disabled={creating !== null}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60 dark:bg-indigo-500"
                  >
                    {creating === "empty" ? <ButtonSpinner size={12} /> : <FilePlus size={12} />} New page
                  </button>
                </div>
              ) : (
                notebooks.map((notebook) => (
                  <NotebookBranch
                    key={notebook.id}
                    company={company}
                    notebook={notebook}
                    roots={tree.get(notebook.id) ?? []}
                    context={context}
                    expanded={expanded}
                    toggle={toggle}
                    activeId={active?.id ?? null}
                  />
                ))
              )}
            </section>
          </>
        )}
      </nav>

      <div className="border-t border-slate-100 p-2 dark:border-slate-800">
        <button
          type="button"
          onClick={onOpenTrash}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          <Trash2 size={14} /> Trash
        </button>
      </div>
    </div>
  );
}

function FlatRow({ note, href, snippet }: { note: NoteOutline; href: string; snippet?: string }) {
  return (
    <NavLink
      to={href}
      className={({ isActive }) =>
        clsx(
          "flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-sm",
          isActive
            ? "bg-slate-200/70 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70",
        )
      }
    >
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
        <NoteIcon icon={note.icon} size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{note.title || "Untitled"}</span>
        {snippet && <span className="block truncate text-xs text-slate-400 dark:text-slate-500">{snippet}</span>}
      </span>
    </NavLink>
  );
}

function QuickFind({
  company,
  context,
  query,
  onQuery,
}: {
  company: Company;
  context: NotesContext;
  query: string;
  onQuery: (q: string) => void;
}) {
  const navigate = useNavigate();
  const [hits, setHits] = React.useState<NoteSearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  const trimmed = query.trim();

  React.useEffect(() => {
    setIndex(0);
    setError(null);
    if (!trimmed) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const rows = await api.get<NoteSearchHit[]>(
          `/api/companies/${company.id}/notes/search?view=outline&q=${encodeURIComponent(trimmed)}`,
        );
        setHits(rows);
      } catch (err) {
        setError(errorMessage(err, "Search failed"));
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [trimmed, company.id]);

  const titleHits = React.useMemo(() => findNotesByTitle(context.notes, trimmed, 8), [context.notes, trimmed]);
  const textHits = React.useMemo(
    () => (hits ?? []).filter((hit) => !titleHits.some((t) => t.id === hit.id)).slice(0, 8),
    [hits, titleHits],
  );
  const results: Array<{ note: NoteOutline; snippet?: string }> = [
    ...titleHits.map((note) => ({ note })),
    ...textHits.map((hit) => ({ note: hit as NoteOutline, snippet: hit.snippet })),
  ];

  return (
    <div className="relative mb-2">
      <Search
        size={13}
        className="pointer-events-none absolute left-2.5 top-[9px] text-slate-400 dark:text-slate-500"
      />
      <input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" && results.length) {
            event.preventDefault();
            setIndex((i) => (i + 1) % results.length);
          } else if (event.key === "ArrowUp" && results.length) {
            event.preventDefault();
            setIndex((i) => (i - 1 + results.length) % results.length);
          } else if (event.key === "Enter" && results[index]) {
            event.preventDefault();
            navigate(context.hrefFor(results[index].note));
            onQuery("");
          } else if (event.key === "Escape") {
            onQuery("");
          }
        }}
        aria-label="Search pages"
        placeholder="Search pages"
        className="w-full rounded-md border border-transparent bg-slate-100/80 py-1.5 pl-7 pr-7 text-sm text-slate-700 placeholder:text-slate-400 hover:bg-slate-100 focus:border-slate-300 focus:bg-white focus:outline-none dark:bg-slate-800/60 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:bg-slate-800 dark:focus:border-slate-600 dark:focus:bg-slate-900"
      />
      {query && (
        <button
          type="button"
          onClick={() => onQuery("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-[5px] flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
        >
          <X size={12} />
        </button>
      )}
      {trimmed && (
        <div role="listbox" aria-label="Search results" className="mt-2">
          {error && <FormError message={error} />}
          {results.length === 0 && !searching && !error && (
            <p className="px-2 py-2 text-xs text-slate-400 dark:text-slate-500">
              No pages match &ldquo;{trimmed}&rdquo;.
            </p>
          )}
          {results.map((result, i) => (
            <div
              key={result.note.id}
              role="option"
              aria-selected={i === index}
              className={clsx("rounded-md", i === index && "ring-1 ring-indigo-300 dark:ring-indigo-700")}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onQuery("")}
            >
              <FlatRow note={result.note} href={context.hrefFor(result.note)} snippet={result.snippet} />
            </div>
          ))}
          {searching && (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-slate-400">
              <Spinner size={12} /> Searching page text…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type DropHint = { id: string; zone: DropZone } | null;

function NotebookBranch({
  company,
  notebook,
  roots,
  context,
  expanded,
  toggle,
  activeId,
}: {
  company: Company;
  notebook: Notebook;
  roots: Array<TreeNode<NoteOutline>>;
  context: NotesContext;
  expanded: Set<string>;
  toggle: (id: string, open?: boolean) => void;
  activeId: string | null;
}) {
  const open = !expanded.has(`collapsed:${notebook.id}`);
  const [hint, setHint] = React.useState<DropHint>(null);
  const [overHeader, setOverHeader] = React.useState(false);
  const busy = context.creating === `notebook:${notebook.id}`;

  return (
    <div className="mb-0.5">
      <div
        className={clsx(
          "group/nb relative flex items-center rounded-md",
          overHeader && "bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-500/10 dark:ring-indigo-700",
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
          event.preventDefault();
          setOverHeader(true);
        }}
        onDragLeave={() => setOverHeader(false)}
        onDrop={(event) => {
          setOverHeader(false);
          const id = event.dataTransfer.getData(DRAG_TYPE);
          const note = context.notes.find((n) => n.id === id);
          if (!note) return;
          event.preventDefault();
          context.movePage(note, notebookDropTarget(context.notes, id, notebook.id));
        }}
      >
        <button
          type="button"
          onClick={() => toggle(`collapsed:${notebook.id}`)}
          aria-label={open ? `Collapse ${notebook.title}` : `Expand ${notebook.title}`}
          aria-expanded={open}
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} />
        </button>
        <NavLink
          to={`/c/${company.slug}/notes/${notebook.slug}`}
          end
          className={({ isActive }) =>
            clsx(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-0.5 pr-1 text-sm font-medium",
              isActive
                ? "bg-slate-200/70 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/70",
            )
          }
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <NoteIcon icon={notebook.icon} kind="notebook" size={13} />
          </span>
          <span className="min-w-0 flex-1 truncate">{notebook.title || "Untitled notebook"}</span>
        </NavLink>
        <button
          type="button"
          onClick={() => void context.createPage({ notebook })}
          disabled={context.creating !== null}
          title={`New page in ${notebook.title}`}
          aria-label={`New page in ${notebook.title}`}
          className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 hover:bg-slate-200/70 hover:text-slate-700 focus-visible:opacity-100 group-hover/nb:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 [@media(hover:none)]:opacity-100"
        >
          {busy ? <ButtonSpinner size={12} /> : <Plus size={13} />}
        </button>
      </div>
      {open && (
        <div role="group">
          {roots.length === 0 ? (
            <button
              type="button"
              onClick={() => void context.createPage({ notebook })}
              className="ml-6 block rounded px-2 py-1 text-left text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            >
              No pages yet — add one
            </button>
          ) : (
            roots.map((node) => (
              <PageBranch
                key={node.note.id}
                node={node}
                depth={1}
                context={context}
                expanded={expanded}
                toggle={toggle}
                activeId={activeId}
                hint={hint}
                setHint={setHint}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function PageBranch({
  node,
  depth,
  context,
  expanded,
  toggle,
  activeId,
  hint,
  setHint,
}: {
  node: TreeNode<NoteOutline>;
  depth: number;
  context: NotesContext;
  expanded: Set<string>;
  toggle: (id: string, open?: boolean) => void;
  activeId: string | null;
  hint: DropHint;
  setHint: (hint: DropHint) => void;
}) {
  const { note } = node;
  const open = expanded.has(note.id);
  const hasChildren = node.children.length > 0;
  const busy = context.creating === `note:${note.id}`;
  const showHint = hint?.id === note.id ? hint.zone : null;
  const href = context.hrefFor(note);

  return (
    <div>
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, note.id);
          event.dataTransfer.setData("text/uri-list", new URL(href, window.location.origin).toString());
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const zone = dropZoneAt(event.clientY - rect.top, rect.height);
          if (hint?.id !== note.id || hint.zone !== zone) setHint({ id: note.id, zone });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHint(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setHint(null);
          const id = event.dataTransfer.getData(DRAG_TYPE);
          const dragged = context.notes.find((n) => n.id === id);
          const rect = event.currentTarget.getBoundingClientRect();
          const zone = dropZoneAt(event.clientY - rect.top, rect.height);
          const target = dragged ? dropTarget(context.notes, id, note.id, zone) : null;
          if (!dragged || !target) return;
          if (zone === "inside") toggle(note.id, true);
          context.movePage(dragged, target);
        }}
        onDragEnd={() => setHint(null)}
        className={clsx(
          "group/page relative flex items-center rounded-md",
          showHint === "inside" && "bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-500/10 dark:ring-indigo-700",
        )}
        // Each level steps in by the same amount; the depth is data, not a class.
        style={{ paddingLeft: depth * 12 }}
      >
        {showHint === "before" && <span aria-hidden className="absolute -top-px left-2 right-0 h-0.5 rounded bg-indigo-400" />}
        {showHint === "after" && <span aria-hidden className="absolute -bottom-px left-2 right-0 h-0.5 rounded bg-indigo-400" />}
        <button
          type="button"
          onClick={() => toggle(note.id)}
          aria-label={open ? `Collapse ${note.title || "Untitled"}` : `Expand ${note.title || "Untitled"}`}
          aria-expanded={hasChildren ? open : undefined}
          className={clsx(
            "flex h-7 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200",
            !hasChildren && "opacity-0 group-hover/page:opacity-60",
          )}
        >
          <ChevronRight size={13} className={clsx("transition-transform", open && hasChildren && "rotate-90")} />
        </button>
        <NavLink
          to={href}
          draggable={false}
          className={clsx(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-0.5 pr-1 text-sm",
            note.id === activeId
              ? "bg-slate-200/70 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70",
          )}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <NoteIcon icon={note.icon} size={13} />
          </span>
          <span className="min-w-0 flex-1 truncate">{note.title || "Untitled"}</span>
        </NavLink>
        <div className="ml-0.5 flex shrink-0 items-center opacity-0 focus-within:opacity-100 group-hover/page:opacity-100 [@media(hover:none)]:opacity-100">
          <PageMenu note={note} context={context} onAddChild={() => toggle(note.id, true)} />
          <button
            type="button"
            onClick={() => {
              toggle(note.id, true);
              void context.createPage({ parent: note });
            }}
            disabled={context.creating !== null}
            title="Add a page inside"
            aria-label={`Add a page inside ${note.title || "Untitled"}`}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            {busy ? <ButtonSpinner size={12} /> : <Plus size={13} />}
          </button>
        </div>
      </div>
      {open && (
        <div role="group">
          {hasChildren ? (
            node.children.map((child) => (
              <PageBranch
                key={child.note.id}
                node={child}
                depth={depth + 1}
                context={context}
                expanded={expanded}
                toggle={toggle}
                activeId={activeId}
                hint={hint}
                setHint={setHint}
              />
            ))
          ) : (
            <div className="py-1 text-xs text-slate-400 dark:text-slate-500" style={{ paddingLeft: (depth + 1) * 12 + 30 }}>
              No pages inside
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PageMenu({
  note,
  context,
  onAddChild,
}: {
  note: NoteOutline;
  context: NotesContext;
  onAddChild: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Menu
      align="left"
      width={210}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-label={`More actions for ${note.title || "Untitled"}`}
          aria-expanded={open}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<FilePlus size={14} />}
            label="Add a page inside"
            onSelect={() => {
              close();
              onAddChild();
              void context.createPage({ parent: note });
            }}
          />
          <MenuItem
            icon={<CopyPlus size={14} />}
            label="Duplicate"
            onSelect={() => {
              close();
              void context.duplicatePage(note);
            }}
          />
          <MenuItem
            icon={<CornerUpRight size={14} />}
            label="Move to…"
            onSelect={() => {
              close();
              context.openMoveDialog(note);
            }}
          />
          <MenuItem
            icon={<Link2 size={14} />}
            label={copied ? "Link copied" : "Copy link"}
            onSelect={() => {
              void copyToClipboard(new URL(context.hrefFor(note), window.location.origin).toString());
              setCopied(true);
              window.setTimeout(() => {
                setCopied(false);
                close();
              }, 700);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="Move to trash"
            className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
            onSelect={() => {
              close();
              context.trashPage(note);
            }}
          />
        </>
      )}
    </Menu>
  );
}

function TrashPanel({
  company,
  context,
  onBack,
}: {
  company: Company;
  context: NotesContext;
  onBack: () => void;
}) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const [rows, setRows] = React.useState<NoteOutline[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const base = `/api/companies/${company.id}`;

  const load = React.useCallback(async () => {
    try {
      const archived = await api.get<NoteOutline[]>(`${base}/notes?archived=true&view=outline`);
      setRows(
        [...archived].sort(
          (a, b) => new Date(b.archivedAt ?? b.updatedAt).getTime() - new Date(a.archivedAt ?? a.updatedAt).getTime(),
        ),
      );
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the trash"));
    }
  }, [base]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const ids = new Set((rows ?? []).map((r) => r.id));
  // Pages trashed with a parent are listed under it; show the top of each trashed tree.
  const tops = (rows ?? []).filter((r) => !r.parentId || !ids.has(r.parentId));
  const nested = (id: string) => (rows ?? []).filter((r) => r.parentId === id).length;

  async function restore(note: NoteOutline) {
    setBusy(`restore:${note.id}`);
    try {
      await api.patch(`${base}/notes/${note.slug}`, { archived: false });
      await Promise.all([load(), context.refresh()]);
      navigate(context.hrefFor(note));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t restore the page" });
    } finally {
      setBusy(null);
    }
  }

  async function destroy(note: NoteOutline) {
    const ok = await dialog.confirm({
      title: `Delete “${note.title || "Untitled"}” forever?`,
      message: "This can't be undone. Pages inside it stay in the trash, one level up.",
      confirmLabel: "Delete forever",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(`delete:${note.id}`);
    try {
      await api.del(`${base}/notes/${note.slug}`);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the page" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pb-2 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to pages"
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          <ArrowLeft size={15} />
        </button>
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Trash</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error && <FormError message={error} className="mx-1" />}
        {rows === null && !error ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-400">
            <Spinner size={12} /> Loading…
          </div>
        ) : tops.length === 0 && !error ? (
          <div className="mx-1 rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            The trash is empty. Pages you move here can be restored, with the pages inside them.
          </div>
        ) : (
          tops.map((note) => {
            const inside = nested(note.id);
            return (
              <div key={note.id} className="group/trash flex items-center gap-1 rounded-md px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800/70">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <NoteIcon icon={note.icon} size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-700 dark:text-slate-200">{note.title || "Untitled"}</span>
                  <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">
                    {note.archivedAt ? `Trashed ${formatRelative(note.archivedAt)}` : ""}
                    {inside > 0 ? ` · ${inside} page${inside === 1 ? "" : "s"} inside` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void restore(note)}
                  disabled={busy !== null}
                  title="Restore"
                  aria-label={`Restore ${note.title || "Untitled"}`}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                >
                  {busy === `restore:${note.id}` ? <ButtonSpinner size={12} /> : <RotateCcw size={13} />}
                </button>
                <button
                  type="button"
                  onClick={() => void destroy(note)}
                  disabled={busy !== null}
                  title="Delete forever"
                  aria-label={`Delete ${note.title || "Untitled"} forever`}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-white hover:text-rose-600 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-rose-400"
                >
                  {busy === `delete:${note.id}` ? <ButtonSpinner size={12} /> : <Trash2 size={13} />}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
