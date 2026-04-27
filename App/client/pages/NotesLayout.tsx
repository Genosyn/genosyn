import React from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { ChevronDown, ChevronRight, FileText, Plus, Trash2 } from "lucide-react";
import { ContextualLayout } from "../components/AppShell";
import { api, Company, Note } from "../lib/api";
import { useToast } from "../components/ui/Toast";

/**
 * Notes section shell. Sidebar shows the per-company note tree (Notion-style
 * collapsible list); the outlet renders the welcome screen, archived view,
 * or a single note's editor.
 *
 * The "+" button creates an "Untitled" note inline and navigates to it —
 * matching Notion's "click to create, then edit in place" feel rather than
 * forcing the user through a separate /new form.
 */
export default function NotesLayout({ company }: { company: Company }) {
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showArchived, setShowArchived] = React.useState(false);
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
  onToggleArchived,
  onCreateTopLevel,
  onCreateChild,
}: {
  company: Company;
  notes: Note[];
  loading: boolean;
  showArchived: boolean;
  onToggleArchived: () => void;
  onCreateTopLevel: () => void;
  onCreateChild: (parent: Note) => void;
}) {
  const tree = React.useMemo(() => buildTree(notes), [notes]);
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {showArchived ? "Trash" : "Notes"}
        </div>
        {!showArchived && (
          <button
            onClick={onCreateTopLevel}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="New note"
            aria-label="New note"
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="px-3 py-2 text-xs text-slate-400">Loading…</div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
            {showArchived ? "Trash is empty." : "No notes yet."}
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
          className={
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm " +
            (showArchived
              ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              : "text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800")
          }
        >
          <Trash2 size={14} />
          <span>{showArchived ? "Hide trash" : "Show trash"}</span>
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
      <div className="group flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-6 w-5 shrink-0 items-center justify-center text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
          aria-label={open ? "Collapse" : "Expand"}
          style={{ marginLeft: `${depth * 12}px` }}
        >
          {hasChildren ? (
            open ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-slate-600" />
          )}
        </button>
        <NavLink
          to={`/c/${company.slug}/notes/${node.slug}`}
          className={({ isActive }) =>
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm " +
            (isActive
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
          }
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-xs">
            {node.icon ? node.icon : <FileText size={13} className="text-slate-400" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{node.title || "Untitled"}</span>
        </NavLink>
        {showAdd && (
          <button
            type="button"
            onClick={() => onCreateChild(node)}
            className="ml-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 group-hover:flex dark:hover:bg-slate-800 dark:hover:text-slate-200"
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

export { Link };
