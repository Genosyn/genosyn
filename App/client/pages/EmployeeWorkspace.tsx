import React from "react";
import { useOutletContext } from "react-router-dom";
import { ChevronDown, ChevronRight, File as FileIcon, Folder, RefreshCw } from "lucide-react";
import { api, WorkspaceFile, WorkspaceNode } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * Employee workspace browser. Tree on the left, editor on the right. The
 * tree is the entire on-disk employee directory (minus .git, node_modules,
 * .DS_Store) — that's the same directory the runner spawns the CLI in,
 * so edits here directly change what the employee sees on its next run.
 *
 * Binary and oversized files show a read-only placeholder.
 */
export default function EmployeeWorkspace() {
  const { company, emp } = useOutletContext<EmployeeOutletCtx>();
  const { toast } = useToast();
  const [tree, setTree] = React.useState<WorkspaceNode | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [file, setFile] = React.useState<WorkspaceFile | null>(null);
  const [draft, setDraft] = React.useState<string>("");
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const loadTree = React.useCallback(async () => {
    try {
      const t = await api.get<WorkspaceNode>(
        `/api/companies/${company.id}/employees/${emp.id}/workspace/tree`,
      );
      setTree(t);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [company.id, emp.id, toast]);

  React.useEffect(() => {
    setSelected(null);
    setFile(null);
    setDraft("");
    setDirty(false);
    loadTree();
  }, [loadTree]);

  React.useEffect(() => {
    if (!selected) return;
    (async () => {
      try {
        const f = await api.get<WorkspaceFile>(
          `/api/companies/${company.id}/employees/${emp.id}/workspace/file?path=${encodeURIComponent(selected)}`,
        );
        setFile(f);
        setDraft(f.type === "text" ? f.content : "");
        setDirty(false);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    })();
  }, [company.id, emp.id, selected, toast]);

  async function save() {
    if (!selected || !file || file.type !== "text") return;
    setSaving(true);
    try {
      await api.put(`/api/companies/${company.id}/employees/${emp.id}/workspace/file`, {
        path: selected,
        content: draft,
      });
      toast("Saved", "success");
      setDirty(false);
      // Refresh the file size metadata silently.
      const f = await api.get<WorkspaceFile>(
        `/api/companies/${company.id}/employees/${emp.id}/workspace/file?path=${encodeURIComponent(selected)}`,
      );
      setFile(f);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        title="Workspace"
        right={
          <Button variant="ghost" size="sm" onClick={loadTree}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />
      <div className="flex min-h-[480px] flex-1 gap-4">
        <div className="w-72 shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 dark:bg-slate-900 dark:border-slate-700">
          {tree === null ? (
            <div className="flex justify-center p-4">
              <Spinner size={16} />
            </div>
          ) : tree.type === "dir" && tree.children.length === 0 ? (
            <div className="p-4 text-xs text-slate-500 dark:text-slate-400">
              Empty workspace. Files appear here once this employee has any
              SOUL / skills / routines created.
            </div>
          ) : (
            <TreeView
              node={tree}
              selected={selected}
              onSelect={(p) => {
                if (dirty && !confirm("Discard unsaved changes?")) return;
                setSelected(p);
              }}
              depth={0}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-10 text-sm text-slate-500 dark:text-slate-400">
              Select a file to view or edit.
            </div>
          ) : file === null ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : file.type === "missing" ? (
            <div className="flex flex-1 items-center justify-center p-10 text-sm text-slate-500 dark:text-slate-400">
              File not found.
            </div>
          ) : file.type === "binary" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-sm text-slate-500 dark:text-slate-400">
              <div className="font-medium text-slate-700 dark:text-slate-200">{selected}</div>
              <div>{file.reason}</div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <div className="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{selected}</div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {file.size} B
                  </span>
                  <Button size="sm" onClick={save} disabled={saving || !dirty}>
                    {saving ? "Saving…" : dirty ? "Save" : "Saved"}
                  </Button>
                </div>
              </div>
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+S saves.
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    save();
                  }
                }}
                spellCheck={false}
                className="h-full min-h-[360px] w-full flex-1 resize-none rounded-b-xl border-0 bg-white p-3 font-mono text-xs text-slate-900 focus:outline-none dark:bg-slate-900 dark:text-slate-100"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Tree view. `isRoot` hides the root directory's own row (the employee
 * root has no interesting name — it's just the slug) while still showing
 * its children as the top level. Every nested directory renders a row
 * with a chevron to expand/collapse.
 */
function TreeView({
  node,
  selected,
  onSelect,
  depth,
  isRoot,
}: {
  node: WorkspaceNode;
  selected: string | null;
  onSelect: (path: string) => void;
  depth: number;
  isRoot?: boolean;
}) {
  if (node.type === "file") {
    const isActive = selected === node.path;
    return (
      <button
        onClick={() => onSelect(node.path)}
        className={
          "flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs " +
          (isActive ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300" : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
        }
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileIcon size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return <DirRow node={node} selected={selected} onSelect={onSelect} depth={depth} isRoot={isRoot} />;
}

function DirRow({
  node,
  selected,
  onSelect,
  depth,
  isRoot,
}: {
  node: Extract<WorkspaceNode, { type: "dir" }>;
  selected: string | null;
  onSelect: (path: string) => void;
  depth: number;
  isRoot?: boolean;
}) {
  // Root + top-level dirs open by default; deeper ones start collapsed.
  const [open, setOpen] = React.useState(depth <= 1);

  if (isRoot) {
    return (
      <div className="flex flex-col">
        {node.children.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">Empty directory.</div>
        ) : (
          node.children.map((c) => (
            <TreeView
              key={c.path || c.name}
              node={c}
              selected={selected}
              onSelect={onSelect}
              depth={0}
            />
          ))
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
        )}
        <Folder size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {open && node.children.length === 0 && (
        <div
          className="text-xs text-slate-400 dark:text-slate-500"
          style={{ paddingLeft: 8 + (depth + 1) * 12 }}
        >
          empty
        </div>
      )}
      {open &&
        node.children.map((c) => (
          <TreeView
            key={c.path || c.name}
            node={c}
            selected={selected}
            onSelect={onSelect}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
