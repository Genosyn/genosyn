import React from "react";
import { Search } from "lucide-react";
import type { Notebook, NoteOutline } from "../../lib/api";
import { buildNoteTree, descendantIds, type DropTarget, type TreeNode } from "../../lib/noteTree";
import { foldSearchText } from "../../lib/searchText";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { clsx } from "../ui/clsx";
import { NoteIcon } from "./NoteIcon";

/**
 * "Move to…": put a page in another notebook or inside another page. The
 * keyboard- and touch-friendly twin of dragging it in the sidebar.
 */
export function MoveNoteModal({
  open,
  note,
  notebooks,
  notes,
  onClose,
  onMove,
}: {
  open: boolean;
  note: NoteOutline | null;
  notebooks: Notebook[];
  notes: NoteOutline[];
  onClose: () => void;
  onMove: (target: DropTarget) => void;
}) {
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const excluded = React.useMemo(
    () => (note ? new Set([note.id, ...descendantIds(notes, note.id)]) : new Set<string>()),
    [note, notes],
  );
  const tree = React.useMemo(() => buildNoteTree(notes.filter((n) => !excluded.has(n.id))), [notes, excluded]);
  const q = foldSearchText(query);
  const matches = (title: string) => !q || foldSearchText(title || "Untitled").includes(q);

  const endOf = (notebookId: string, parentId: string | null) =>
    notes.filter((n) => n.notebookId === notebookId && (n.parentId ?? null) === parentId && !excluded.has(n.id)).length;

  const renderPages = (nodes: Array<TreeNode<NoteOutline>>, depth: number): React.ReactNode =>
    nodes.map((node) => {
      const visible = matches(node.note.title);
      const current = note?.parentId === node.note.id;
      return (
        <React.Fragment key={node.note.id}>
          {visible && (
            <button
              type="button"
              disabled={current}
              onClick={() => onMove({ notebookId: node.note.notebookId, parentId: node.note.id, index: endOf(node.note.notebookId, node.note.id) })}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm",
                current
                  ? "cursor-default text-slate-400 dark:text-slate-500"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
              )}
              // Nested pages step in by depth, which is data.
              style={{ paddingLeft: 8 + depth * 16 }}
            >
              <NoteIcon icon={node.note.icon} size={13} />
              <span className="min-w-0 flex-1 truncate">{node.note.title || "Untitled"}</span>
              {current && <span className="text-xs">Current</span>}
            </button>
          )}
          {renderPages(node.children, depth + 1)}
        </React.Fragment>
      );
    });

  return (
    <Modal
      open={open && note !== null}
      onClose={onClose}
      title={`Move “${note?.title || "Untitled"}”`}
      description="Choose a notebook, or a page to put it inside. Pages inside it come along."
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a notebook or page"
          aria-label="Find a notebook or page"
          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
        />
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {notebooks.map((notebook) => {
          const top = note?.notebookId === notebook.id && !note.parentId;
          return (
            <div key={notebook.id} className="mb-1">
              {matches(notebook.title) && (
                <button
                  type="button"
                  disabled={top}
                  onClick={() => onMove({ notebookId: notebook.id, parentId: null, index: endOf(notebook.id, null) })}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium",
                    top
                      ? "cursor-default text-slate-400 dark:text-slate-500"
                      : "text-slate-800 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800",
                  )}
                >
                  <NoteIcon icon={notebook.icon} kind="notebook" size={14} />
                  <span className="min-w-0 flex-1 truncate">{notebook.title}</span>
                  {top && <span className="text-xs font-normal">Current</span>}
                </button>
              )}
              {renderPages(tree.get(notebook.id) ?? [], 1)}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
