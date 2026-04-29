import React from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { ContextualLayout } from "../components/AppShell";
import { api, Company, Note } from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Notes section shell. Sidebar shows the per-company note tree (Notion-style
 * collapsible list with a sticky search + new-page header); the outlet
 * renders the welcome screen, archived view, or a single note's editor.
 *
 * The "+" button creates an "Untitled" note inline and navigates to it —
 * matching Notion's "click to create, then edit in place" feel rather than
 * forcing the user through a separate /new form.
 */
export default function NotesLayout({ company }: { company: Company }) {
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showArchived, setShowArchived] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const params = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const refresh = React.useCallback(async () => {
    try {
      const rows = await api.get<Note[]>(
        `/api/companies/${company.id}/notes${showArchived ? "?archived=true" : ""}`,
      );
      setNotes(rows);
    } finally {
      setLoading(false);
    }
  }, [company.id, showArchived]);

  React.useEffect(() => {
    refresh();
  }, [refresh, params.noteSlug]);

  const createTopLevel = React.useCallback(async () => {
    try {
      const created = await api.post<Note>(`/api/companies/${company.id}/notes`, {
        title: "Untitled",
      });
      await refresh();
      navigate(`/c/${company.slug}/notes/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [company.id, company.slug, navigate, refresh, toast]);

  const createChild = React.useCallback(
    async (parent: Note) => {
      try {
        const created = await api.post<Note>(`/api/companies/${company.id}/notes`, {
          title: "Untitled",
          parentSlug: parent.slug,
        });
        await refresh();
        navigate(`/c/${company.slug}/notes/${created.slug}`);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    },
    [company.id, company.slug, navigate, refresh, toast],
  );

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          notes={notes}
          loading={loading}
          showArchived={showArchived}
          filter={filter}
          onFilter={setFilter}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onCreateTopLevel={createTopLevel}
          onCreateChild={createChild}
        />
      }
    >
      <Outlet context={{ notes, refresh } satisfies NotesContext} />
    </ContextualLayout>
  );
}

export type NotesContext = {
  notes: Note[];
  refresh: () => Promise<void>;
};

function Sidebar({
  company,
  notes,
  loading,
  showArchived,
  filter,
  onFilter,
  onToggleArchived,
  onCreateTopLevel,
  onCreateChild,
}: {
  company: Company;
  notes: Note[];
  loading: boolean;
  showArchived: boolean;
  filter: string;
  onFilter: (q: string) => void;
  onToggleArchived: () => void;
  onCreateTopLevel: () => void;
  onCreateChild: (parent: Note) => void;
}) {
  const tree = React.useMemo(() => buildTree(notes), [notes]);
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
            {showArchived ? "Trash" : "Notes"}
          </span>
          {!showArchived && (
            <button
              onClick={onCreateTopLevel}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="New page"
              aria-label="New page"
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
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="px-3 py-2 text-xs text-slate-400">Loading…</div>
        ) : filteredFlat ? (
          filteredFlat.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
              No matching pages.
            </div>
          ) : (
            filteredFlat.map((n) => (
              <FlatNoteRow key={n.id} company={company} note={n} />
            ))
          )
        ) : tree.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <div className="mb-2 text-xs text-slate-400 dark:text-slate-500">
              {showArchived ? "Trash is empty." : "No pages yet."}
            </div>
            {!showArchived && (
              <button
                onClick={onCreateTopLevel}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
              >
                <Plus size={12} /> New page
              </button>
            )}
          </div>
        ) : (
          tree.map((n) => (
            <NoteRow
              key={n.id}
              company={company}
              node={n}
              depth={0}
              onCreateChild={onCreateChild}
              showAdd={!showArchived}
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

function NoteRow({
  company,
  node,
  depth,
  onCreateChild,
  showAdd,
}: {
  company: Company;
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
          to={`/c/${company.slug}/notes/${node.slug}`}
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

function FlatNoteRow({ company, note }: { company: Company; note: Note }) {
  return (
    <NavLink
      to={`/c/${company.slug}/notes/${note.slug}`}
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
