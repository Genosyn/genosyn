import React from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Book,
  ChevronDown,
  ChevronRight,
  FileText,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { ContextualLayout } from "../components/AppShell";
import { api, Company, Note, Notebook } from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Notes section shell. The sidebar lists every Notebook in the company;
 * inside each notebook is its own collapsible Notion-style note tree. The
 * outlet renders the welcome screen, archived view, or a single note's
 * editor.
 *
 * Notebooks themselves do not nest — only the notes inside them do.
 * Adding a page from the notebook header creates an "Untitled" note inside
 * that notebook; the "+" next to a note creates a sub-page in the same
 * notebook as its parent.
 */
export default function NotesLayout({ company }: { company: Company }) {
  const [notebooks, setNotebooks] = React.useState<Notebook[]>([]);
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showArchived, setShowArchived] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();

  const refresh = React.useCallback(async () => {
    try {
      const [nbRows, noteRows] = await Promise.all([
        api.get<Notebook[]>(`/api/companies/${company.id}/notebooks`),
        api.get<Note[]>(
          `/api/companies/${company.id}/notes${showArchived ? "?archived=true" : ""}`,
        ),
      ]);
      setNotebooks(nbRows);
      setNotes(noteRows);
    } finally {
      setLoading(false);
    }
  }, [company.id, showArchived]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const createNoteInNotebook = React.useCallback(
    async (notebook: Notebook) => {
      try {
        const created = await api.post<Note>(`/api/companies/${company.id}/notes`, {
          title: "Untitled",
          notebookSlug: notebook.slug,
        });
        await refresh();
        navigate(`/c/${company.slug}/notes/${notebook.slug}/${created.slug}`);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    },
    [company.id, company.slug, navigate, refresh, toast],
  );

  const createChild = React.useCallback(
    async (parent: Note, notebook: Notebook) => {
      try {
        const created = await api.post<Note>(`/api/companies/${company.id}/notes`, {
          title: "Untitled",
          parentSlug: parent.slug,
        });
        await refresh();
        navigate(`/c/${company.slug}/notes/${notebook.slug}/${created.slug}`);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    },
    [company.id, company.slug, navigate, refresh, toast],
  );

  const createNotebook = React.useCallback(async () => {
    const title = await dialog.prompt({
      title: "New notebook",
      message: "Notebooks group related pages — runbooks, briefs, post-mortems, etc.",
      placeholder: "Notebook name",
      confirmLabel: "Create",
    });
    if (!title) return;
    try {
      const created = await api.post<Notebook>(
        `/api/companies/${company.id}/notebooks`,
        { title },
      );
      await refresh();
      navigate(`/c/${company.slug}/notes/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [company.id, company.slug, dialog, navigate, refresh, toast]);

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          notebooks={notebooks}
          notes={notes}
          loading={loading}
          showArchived={showArchived}
          filter={filter}
          onFilter={setFilter}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onCreateNote={createNoteInNotebook}
          onCreateChild={createChild}
          onCreateNotebook={createNotebook}
        />
      }
    >
      <Outlet
        context={{ notebooks, notes, refresh } satisfies NotesContext}
      />
    </ContextualLayout>
  );
}

export type NotesContext = {
  notebooks: Notebook[];
  notes: Note[];
  refresh: () => Promise<void>;
};

function Sidebar({
  company,
  notebooks,
  notes,
  loading,
  showArchived,
  filter,
  onFilter,
  onToggleArchived,
  onCreateNote,
  onCreateChild,
  onCreateNotebook,
}: {
  company: Company;
  notebooks: Notebook[];
  notes: Note[];
  loading: boolean;
  showArchived: boolean;
  filter: string;
  onFilter: (q: string) => void;
  onToggleArchived: () => void;
  onCreateNote: (notebook: Notebook) => void;
  onCreateChild: (parent: Note, notebook: Notebook) => void;
  onCreateNotebook: () => void;
}) {
  const notesByNotebook = React.useMemo(() => {
    const m = new Map<string, Note[]>();
    for (const n of notes) {
      const list = m.get(n.notebookId);
      if (list) list.push(n);
      else m.set(n.notebookId, [n]);
    }
    return m;
  }, [notes]);

  const filteredFlat = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    return notes
      .filter((n) => (n.title || "").toLowerCase().includes(q))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, 30);
  }, [filter, notes]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-3 pt-3">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {showArchived ? "Trash" : "Notebooks"}
          </span>
          {!showArchived && (
            <button
              onClick={onCreateNotebook}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="New notebook"
              aria-label="New notebook"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {!showArchived && (
          <div className="relative mb-2">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
              placeholder="Quick find"
              className="w-full rounded-md border border-transparent bg-slate-100/70 py-1.5 pl-7 pr-2 text-sm text-slate-700 placeholder:text-slate-400 hover:bg-slate-100 focus:border-slate-300 focus:bg-white focus:outline-none dark:bg-slate-800/60 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:bg-slate-800 dark:focus:border-slate-600 dark:focus:bg-slate-900"
            />
          </div>
        )}
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="px-3 py-2 text-xs text-slate-400">Loading…</div>
        ) : filteredFlat ? (
          filteredFlat.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
              No matching pages.
            </div>
          ) : (
            filteredFlat.map((n) => {
              const nb = notebooks.find((x) => x.id === n.notebookId);
              return (
                <FlatNoteRow
                  key={n.id}
                  company={company}
                  note={n}
                  notebookSlug={nb?.slug ?? ""}
                />
              );
            })
          )
        ) : notebooks.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <div className="mb-2 text-xs text-slate-400 dark:text-slate-500">
              No notebooks yet.
            </div>
            <button
              onClick={onCreateNotebook}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
            >
              <Plus size={12} /> New notebook
            </button>
          </div>
        ) : (
          notebooks.map((nb) => (
            <NotebookSection
              key={nb.id}
              company={company}
              notebook={nb}
              notes={notesByNotebook.get(nb.id) ?? []}
              showAdd={!showArchived}
              onCreateNote={() => onCreateNote(nb)}
              onCreateChild={(parent) => onCreateChild(parent, nb)}
            />
          ))
        )}
      </nav>
      <div className="mt-auto border-t border-slate-100 px-2 py-2 dark:border-slate-800">
        <button
          onClick={onToggleArchived}
          className={clsx(
            "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm",
            showArchived
              ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              : "text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
          )}
        >
          <Trash2 size={13} />
          <span>{showArchived ? "Hide trash" : "Trash"}</span>
        </button>
      </div>
    </div>
  );
}

type NoteNode = Note & { children: NoteNode[] };

function buildTree(notes: Note[]): NoteNode[] {
  const byId = new Map<string, NoteNode>();
  for (const n of notes) byId.set(n.id, { ...n, children: [] });
  const roots: NoteNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sorter = (a: NoteNode, b: NoteNode) =>
    a.sortOrder - b.sortOrder ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  roots.sort(sorter);
  for (const node of byId.values()) node.children.sort(sorter);
  return roots;
}

function NotebookSection({
  company,
  notebook,
  notes,
  showAdd,
  onCreateNote,
  onCreateChild,
}: {
  company: Company;
  notebook: Notebook;
  notes: Note[];
  showAdd: boolean;
  onCreateNote: () => void;
  onCreateChild: (parent: Note) => void;
}) {
  const [open, setOpen] = React.useState(true);
  const tree = React.useMemo(() => buildTree(notes), [notes]);
  return (
    <div>
      <div className="group/nb relative flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="absolute left-1 flex h-6 w-4 shrink-0 items-center justify-center text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <NavLink
          to={`/c/${company.slug}/notes/${notebook.slug}`}
          end
          className={({ isActive }) =>
            clsx(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-6 pr-1 text-sm font-medium",
              isActive
                ? "bg-slate-200/70 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70",
            )
          }
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[13px]">
            {notebook.icon ? (
              <span aria-hidden>{notebook.icon}</span>
            ) : (
              <Book size={13} className="text-slate-400 dark:text-slate-500" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {notebook.title || "Untitled notebook"}
          </span>
          {notebook.noteCount > 0 && (
            <span className="ml-1 shrink-0 rounded text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
              {notebook.noteCount}
            </span>
          )}
        </NavLink>
        {showAdd && (
          <button
            type="button"
            onClick={onCreateNote}
            className="ml-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 group-hover/nb:flex dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="New page in this notebook"
            aria-label="New page in this notebook"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {open && (
        <div className="mt-0.5">
          {tree.length === 0 ? (
            <div className="px-3 pb-1 pl-6 text-[11px] text-slate-400 dark:text-slate-500">
              No pages yet.
            </div>
          ) : (
            tree.map((n) => (
              <NoteRow
                key={n.id}
                company={company}
                notebookSlug={notebook.slug}
                node={n}
                depth={1}
                onCreateChild={onCreateChild}
                showAdd={showAdd}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function NoteRow({
  company,
  notebookSlug,
  node,
  depth,
  onCreateChild,
  showAdd,
}: {
  company: Company;
  notebookSlug: string;
  node: NoteNode;
  depth: number;
  onCreateChild: (parent: Note) => void;
  showAdd: boolean;
}) {
  const [open, setOpen] = React.useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        className="group relative flex items-center"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={clsx(
            "absolute left-0 flex h-7 w-5 shrink-0 items-center justify-center text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200",
            !hasChildren && "pointer-events-none opacity-0 group-hover:opacity-60",
          )}
          aria-label={open ? "Collapse" : "Expand"}
          style={{ left: `${depth * 14}px` }}
        >
          {hasChildren ? (
            open ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </button>
        <NavLink
          to={`/c/${company.slug}/notes/${notebookSlug}/${node.slug}`}
          className={({ isActive }) =>
            clsx(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-5 pr-1 text-sm",
              isActive
                ? "bg-slate-200/70 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70",
            )
          }
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[13px]">
            {node.icon ? (
              <span aria-hidden>{node.icon}</span>
            ) : (
              <FileText size={13} className="text-slate-400 dark:text-slate-500" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {node.title || "Untitled"}
          </span>
        </NavLink>
        {showAdd && (
          <button
            type="button"
            onClick={() => onCreateChild(node)}
            className="ml-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 group-hover:flex dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="New sub-page"
            aria-label="New sub-page"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((c) => (
            <NoteRow
              key={c.id}
              company={company}
              notebookSlug={notebookSlug}
              node={c}
              depth={depth + 1}
              onCreateChild={onCreateChild}
              showAdd={showAdd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlatNoteRow({
  company,
  note,
  notebookSlug,
}: {
  company: Company;
  note: Note;
  notebookSlug: string;
}) {
  return (
    <NavLink
      to={`/c/${company.slug}/notes/${notebookSlug}/${note.slug}`}
      className={({ isActive }) =>
        clsx(
          "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm",
          isActive
            ? "bg-slate-200/70 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70",
        )
      }
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[13px]">
        {note.icon ? (
          <span aria-hidden>{note.icon}</span>
        ) : (
          <FileText size={13} className="text-slate-400 dark:text-slate-500" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {note.title || "Untitled"}
      </span>
    </NavLink>
  );
}

export { Link };
