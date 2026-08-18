import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  File as FileIcon,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Upload,
  X,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { DiffView } from "../components/repositories/DiffView";
import {
  api,
  RepositoryBranch,
  RepositoryBranchesResponse,
  RepositoryChange,
  RepositoryChangeStatus,
  RepositoryCommitResult,
  RepositoryDiff,
  RepositoryFileContent,
  RepositoryStatus,
  RepositoryTreeEntry,
  RepositoryTreeResponse,
} from "../lib/api";
import { useRepositoriesContext } from "./RepositoriesLayout";

/**
 * The working surface for a repository: browse the tree, edit a file, review
 * what changed, commit it, move between branches.
 *
 * Everything here talks to the App-owned checkout, which is a real git working
 * copy — so the page is deliberately a git client and not a document editor.
 * Saving writes the file and stops there; nothing leaves the machine until
 * someone commits, and nothing reaches the remote until someone pushes.
 */

const EMPTY_STATUS: RepositoryStatus = {
  branch: null,
  unborn: false,
  detached: false,
  ahead: 0,
  behind: 0,
  upstream: null,
  changes: [],
};

const CHANGE_META: Record<RepositoryChangeStatus, { label: string; className: string }> = {
  added: {
    label: "A",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  modified: {
    label: "M",
    className: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  },
  deleted: {
    label: "D",
    className: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  },
  renamed: {
    label: "R",
    className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  untracked: {
    label: "U",
    className: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
  conflicted: {
    label: "!",
    className: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",
  },
};

const CODE_EXTENSIONS = new Set([
  "c",
  "cjs",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "yaml",
  "yml",
]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isMarkdown(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

function parentDirectory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** A path segment git will accept, checked before we bother the server. */
function invalidPathMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Required";
  if (trimmed.startsWith("/")) return "Use a path relative to the repository root.";
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    return "Paths cannot step outside the repository.";
  }
  if (trimmed.split("/")[0] === ".git") return "The .git directory is off limits.";
  return null;
}

export default function RepositoryFiles() {
  const { company, repo } = useRepositoriesContext();
  const { toast } = useToast();
  const dialog = useDialog();

  const base = repo ? `/api/companies/${company.id}/repositories/${repo.slug}` : "";
  const repoId = repo?.id ?? null;
  const documentsFirst = repo?.kind === "documents";
  const isRemote = repo?.origin === "remote";

  const [status, setStatus] = React.useState<RepositoryStatus | null>(null);
  const [branches, setBranches] = React.useState<RepositoryBranch[]>([]);
  const [dirs, setDirs] = React.useState<Record<string, RepositoryTreeEntry[]>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([""]));
  const [busy, setBusy] = React.useState(false);

  const [openPath, setOpenPath] = React.useState<string | null>(null);
  const [file, setFile] = React.useState<RepositoryFileContent | null>(null);
  const [fileLoading, setFileLoading] = React.useState(false);
  const [content, setContent] = React.useState("");
  const [savedContent, setSavedContent] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);

  const [diffPath, setDiffPath] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<RepositoryDiff | null>(null);

  const [showChanges, setShowChanges] = React.useState(true);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [message, setMessage] = React.useState("");
  const [committing, setCommitting] = React.useState(false);

  const editorRef = React.useRef<HTMLTextAreaElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const caretRef = React.useRef<number | null>(null);
  // The tree reload has to re-fetch exactly the directories already on screen,
  // and reading them from state would make every callback churn.
  const dirsRef = React.useRef(dirs);
  dirsRef.current = dirs;
  // Guards against a slow file response landing after a faster later one.
  const openTokenRef = React.useRef(0);

  const loadDir = React.useCallback(
    async (path: string) => {
      if (!base) return;
      try {
        const response = await api.get<RepositoryTreeResponse>(
          `${base}/workspace/tree?path=${encodeURIComponent(path)}`,
        );
        setDirs((current) => ({ ...current, [path]: response.entries }));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        setDirs((current) => ({ ...current, [path]: [] }));
      }
    },
    [base, toast],
  );

  const reloadTree = React.useCallback(async () => {
    await Promise.all(Object.keys(dirsRef.current).map((path) => loadDir(path)));
  }, [loadDir]);

  const reloadStatus = React.useCallback(async () => {
    if (!base) return;
    try {
      const [nextStatus, branchRows] = await Promise.all([
        api.get<RepositoryStatus>(`${base}/workspace/status`),
        api.get<RepositoryBranchesResponse>(`${base}/workspace/branches`),
      ]);
      setStatus(nextStatus);
      setBranches(branchRows.branches);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setStatus(EMPTY_STATUS);
    }
  }, [base, toast]);

  React.useEffect(() => {
    if (!base) return;
    // Switching repositories has to drop every cached listing and the open
    // file with it, or the tree briefly shows the previous repo's paths.
    setDirs({});
    setExpanded(new Set([""]));
    setOpenPath(null);
    setFile(null);
    setSavedContent(null);
    setDiffPath(null);
    setDiff(null);
    setMessage("");
    loadDir("");
    reloadStatus();
  }, [base, loadDir, reloadStatus]);

  useLiveRefetch("repository", reloadStatus, repoId);

  const changes = React.useMemo(() => status?.changes ?? [], [status]);
  const changedPaths = React.useMemo(
    () => new Set(changes.map((change) => change.path)),
    [changes],
  );

  // Everything git reports starts staged for the next commit; a box the Member
  // unticked stays unticked for as long as that path is still listed.
  const knownPathsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const present = new Set(changes.map((change) => change.path));
    setSelected((current) => {
      const next = new Set<string>();
      for (const path of present) {
        if (!knownPathsRef.current.has(path) || current.has(path)) next.add(path);
      }
      return next;
    });
    knownPathsRef.current = present;
  }, [changes]);

  const openFile = React.useCallback(
    async (path: string) => {
      if (!base) return;
      const token = openTokenRef.current + 1;
      openTokenRef.current = token;
      setDiffPath(null);
      setDiff(null);
      setOpenPath(path);
      setFile(null);
      setSavedContent(null);
      setFileLoading(true);
      try {
        const row = await api.get<RepositoryFileContent>(
          `${base}/workspace/file?path=${encodeURIComponent(path)}`,
        );
        if (openTokenRef.current !== token) return;
        setFile(row);
        setContent(row.content ?? "");
        setSavedContent(row.content);
        setPreviewing(isMarkdown(path) && documentsFirst);
      } catch (err) {
        if (openTokenRef.current !== token) return;
        toast(err instanceof Error ? err.message : String(err), "error");
        setOpenPath(null);
      } finally {
        if (openTokenRef.current === token) setFileLoading(false);
      }
    },
    [base, documentsFirst, toast],
  );

  const dirty = savedContent !== null && content !== savedContent;

  const save = React.useCallback(async () => {
    if (!base || !openPath || savedContent === null || content === savedContent || saving) return;
    setSaving(true);
    try {
      await api.put(`${base}/workspace/file`, { path: openPath, content });
      setSavedContent(content);
      await reloadStatus();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }, [base, content, openPath, reloadStatus, saving, savedContent, toast]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Tab inserts spaces rather than moving focus, so the caret has to be put
  // back by hand once React has re-rendered the textarea with the new value.
  React.useEffect(() => {
    const caret = caretRef.current;
    if (caret === null || !editorRef.current) return;
    editorRef.current.selectionStart = caret;
    editorRef.current.selectionEnd = caret;
    caretRef.current = null;
  }, [content]);

  const openDiff = React.useCallback(
    async (path: string) => {
      if (!base) return;
      setDiffPath(path);
      setDiff(null);
      try {
        const row = await api.get<RepositoryDiff>(
          `${base}/workspace/diff?path=${encodeURIComponent(path)}`,
        );
        setDiff(row);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        setDiffPath(null);
      }
    },
    [base, toast],
  );

  if (!repo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const currentRepo = repo;
  const currentStatus = status;
  const localBranches = branches.filter((branch) => !branch.remote);
  const localNames = new Set(localBranches.map((branch) => branch.name));
  // A remote branch is listed as `origin/x`, but checkout expects the bare
  // name — and once a local `x` exists the remote row is just a duplicate.
  const remoteBranches = branches
    .filter((branch) => branch.remote)
    .map((branch) => ({ ...branch, bare: branch.name.replace(/^origin\//, "") }))
    .filter((branch) => !localNames.has(branch.bare));

  async function confirmLeavingUnsaved(): Promise<boolean> {
    if (!dirty) return true;
    return dialog.confirm({
      title: "Discard unsaved edits?",
      message: `${openPath} has changes that have not been written to the working copy yet.`,
      confirmLabel: "Discard edits",
      variant: "danger",
    });
  }

  async function selectFile(path: string) {
    if (path === openPath && !diffPath) return;
    if (!(await confirmLeavingUnsaved())) return;
    await openFile(path);
  }

  async function toggleDirectory(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!dirsRef.current[path]) await loadDir(path);
    }
    setExpanded(next);
  }

  async function refresh() {
    setBusy(true);
    try {
      // The only read that costs a round trip to the git host.
      const next = await api.post<RepositoryStatus>(`${base}/workspace/refresh`);
      setStatus(next);
      const branchRows = await api.get<RepositoryBranchesResponse>(`${base}/workspace/branches`);
      setBranches(branchRows.branches);
      await reloadTree();
      toast(isRemote ? "Refreshed from the remote" : "Refreshed", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function checkout(name: string) {
    if (!(await confirmLeavingUnsaved())) return;
    setBusy(true);
    try {
      await api.post(`${base}/workspace/checkout`, { name });
      await Promise.all([reloadStatus(), reloadTree()]);
      if (openPath) await openFile(openPath);
      toast(`Switched to ${name}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function createBranch() {
    const name = await dialog.prompt({
      title: "New branch",
      message: `Branches off ${currentStatus?.branch ?? currentRepo.defaultBranch} and switches to it.`,
      placeholder: "feature/pricing-page",
      confirmLabel: "Create branch",
      validate: (value) =>
        /^[A-Za-z0-9._][A-Za-z0-9._\-/]*$/.test(value.trim())
          ? null
          : "Letters, numbers, dot, dash, underscore, and slash only.",
    });
    if (!name) return;
    setBusy(true);
    try {
      await api.post(`${base}/workspace/branches`, { name: name.trim() });
      await Promise.all([reloadStatus(), reloadTree()]);
      toast(`Created ${name.trim()}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    const branch = currentStatus?.branch;
    if (!branch) {
      toast("Check out a branch before pushing.", "error");
      return;
    }
    setBusy(true);
    try {
      await api.post(`${base}/workspace/push`, { name: branch });
      await reloadStatus();
      toast(`Pushed ${branch}`, "success");
    } catch (err) {
      // A 403 here is the "only an owner or admin can push" rule. Its wording
      // is the whole value of the response, so it is shown verbatim.
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function createEntry(kind: "file" | "directory") {
    const path = await dialog.prompt({
      title: kind === "file" ? "New file" : "New folder",
      message: "Path relative to the repository root.",
      placeholder: kind === "file" ? "docs/plan.md" : "docs/archive",
      confirmLabel: "Create",
      validate: invalidPathMessage,
    });
    if (!path) return;
    const clean = path.trim();
    try {
      if (kind === "file") {
        await api.put(`${base}/workspace/file`, { path: clean, content: "" });
      } else {
        await api.post(`${base}/workspace/directory`, { path: clean });
      }
      // Reveal what was just created instead of leaving it buried in a
      // collapsed branch of the tree.
      const parent = parentDirectory(clean);
      const reveal = new Set(expanded);
      const segments = clean.split("/").slice(0, -1);
      let walked = "";
      for (const segment of segments) {
        walked = walked ? `${walked}/${segment}` : segment;
        reveal.add(walked);
      }
      if (kind === "directory") reveal.add(clean);
      setExpanded(reveal);
      await Promise.all([...reveal].map((dir) => loadDir(dir)));
      if (parent) await loadDir(parent);
      await reloadStatus();
      if (kind === "file") await openFile(clean);
      toast(kind === "file" ? "File created" : "Folder created", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function discardChange(change: RepositoryChange) {
    const ok = await dialog.confirm({
      title: `Discard changes to ${change.path}?`,
      message:
        change.status === "untracked"
          ? "This file has never been committed, so discarding it deletes it outright."
          : "The file goes back to its last committed state. There is no undo.",
      confirmLabel: "Discard changes",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.post(`${base}/workspace/discard`, { paths: [change.path] });
      await Promise.all([reloadStatus(), reloadTree()]);
      if (diffPath === change.path) {
        setDiffPath(null);
        setDiff(null);
      }
      if (openPath === change.path) await openFile(change.path);
      toast("Changes discarded", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function commit() {
    if (!message.trim()) {
      toast("Write a commit message.", "error");
      return;
    }
    if (selected.size === 0) {
      toast("Pick at least one file to commit.", "error");
      return;
    }
    setCommitting(true);
    try {
      const everything = selected.size === changes.length;
      const result = await api.post<RepositoryCommitResult>(`${base}/workspace/commit`, {
        message: message.trim(),
        // Omitting `paths` commits the whole working tree, which is both the
        // common case and the one that also picks up deletions correctly.
        ...(everything ? {} : { paths: [...selected] }),
      });
      setMessage("");
      setDiffPath(null);
      setDiff(null);
      await Promise.all([reloadStatus(), reloadTree()]);
      toast(`Committed ${result.sha.slice(0, 7)}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setCommitting(false);
    }
  }

  function onEditorKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setContent(content.slice(0, start) + "  " + content.slice(end));
    caretRef.current = start + 2;
  }

  const branchLabel = currentStatus?.detached
    ? "detached HEAD"
    : (currentStatus?.branch ?? currentRepo.defaultBranch);

  return (
    <div className="pb-12">
      <div className="flex flex-wrap items-center gap-2">
        <Menu
          align="left"
          width={300}
          trigger={({ ref, onClick, open }) => (
            <button
              ref={ref}
              onClick={onClick}
              disabled={busy}
              className="inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              aria-label="Switch branch"
            >
              <GitBranch size={14} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{branchLabel}</span>
              <ChevronDown
                size={13}
                className={"shrink-0 text-slate-400 " + (open ? "rotate-180" : "")}
              />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuHeader>This repository</MenuHeader>
              {localBranches.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500">
                  No branches yet — the first commit creates one.
                </div>
              )}
              {localBranches.map((branch) => (
                <MenuItem
                  key={branch.name}
                  active={branch.current}
                  icon={<GitBranch size={13} />}
                  label={<span className="font-mono text-xs">{branch.name}</span>}
                  onSelect={() => {
                    close();
                    if (!branch.current) checkout(branch.name);
                  }}
                />
              ))}
              {remoteBranches.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuHeader>On the remote</MenuHeader>
                  {remoteBranches.slice(0, 20).map((branch) => (
                    <MenuItem
                      key={branch.name}
                      icon={<GitBranch size={13} />}
                      label={<span className="font-mono text-xs">{branch.bare}</span>}
                      hint="track"
                      onSelect={() => {
                        close();
                        checkout(branch.bare);
                      }}
                    />
                  ))}
                </>
              )}
              <MenuSeparator />
              <MenuItem
                icon={<FilePlus2 size={13} />}
                label="New branch…"
                onSelect={() => {
                  close();
                  createBranch();
                }}
              />
            </>
          )}
        </Menu>

        {currentStatus && (currentStatus.ahead > 0 || currentStatus.behind > 0) && (
          <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[11px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {currentStatus.ahead > 0 && (
              <span title="Commits not on the remote">↑{currentStatus.ahead}</span>
            )}
            {currentStatus.behind > 0 && (
              <span title="Commits only on the remote">↓{currentStatus.behind}</span>
            )}
          </span>
        )}
        {currentStatus?.unborn && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            No commits yet
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowChanges((current) => !current)}
            aria-pressed={showChanges}
          >
            <GitCommitHorizontal size={14} />
            Changes
            {changes.length > 0 && (
              <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                {changes.length}
              </span>
            )}
          </Button>
          <Button size="sm" variant="secondary" onClick={refresh} disabled={busy}>
            {busy ? <Spinner size={14} /> : <RefreshCw size={14} />}
            Refresh
          </Button>
          {isRemote && (
            <Button size="sm" onClick={push} disabled={busy}>
              <Upload size={14} /> Push
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 flex min-h-0 flex-col gap-4 lg:h-[calc(100vh-14rem)] lg:min-h-[30rem] lg:flex-row">
        <aside className="flex max-h-80 min-h-0 w-full shrink-0 flex-col rounded-xl border border-slate-200 bg-white lg:max-h-none lg:w-64 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-1 border-b border-slate-100 px-2 py-1.5 dark:border-slate-800">
            <span className="min-w-0 flex-1 truncate pl-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Files
            </span>
            <IconButton title="New file" onClick={() => createEntry("file")}>
              <FilePlus2 size={14} />
            </IconButton>
            <IconButton title="New folder" onClick={() => createEntry("directory")}>
              <FolderPlus size={14} />
            </IconButton>
            <IconButton title="Reload the tree" onClick={() => void reloadTree()}>
              <RefreshCw size={14} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            <TreeLevel
              path=""
              dirs={dirs}
              expanded={expanded}
              changedPaths={changedPaths}
              activePath={openPath}
              onToggle={toggleDirectory}
              onOpen={selectFile}
            />
          </div>
        </aside>

        <section className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600 dark:text-slate-300">
              {diffPath ?? openPath ?? "No file open"}
            </span>
            {diffPath ? (
              <Button size="sm" variant="ghost" onClick={() => setDiffPath(null)}>
                <X size={13} /> Close diff
              </Button>
            ) : (
              openPath &&
              file &&
              file.content !== null && (
                <>
                  {isMarkdown(openPath) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPreviewing((current) => !current)}
                    >
                      {previewing ? <Pencil size={13} /> : <Eye size={13} />}
                      {previewing ? "Edit" : "Preview"}
                    </Button>
                  )}
                  <span
                    className={
                      "shrink-0 text-xs " +
                      (dirty
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-slate-400 dark:text-slate-500")
                    }
                    aria-live="polite"
                  >
                    {saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}
                  </span>
                  <Button size="sm" variant="secondary" onClick={save} disabled={!dirty || saving}>
                    <Save size={13} /> Save
                  </Button>
                </>
              )
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {diffPath ? (
              diff === null ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner size={20} />
                </div>
              ) : (
                <div className="p-3">
                  <DiffView
                    patch={diff.patch}
                    truncated={diff.truncated}
                    emptyMessage="This file matches the last commit."
                  />
                </div>
              )
            ) : fileLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner size={20} />
              </div>
            ) : !openPath || !file ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-14 text-center">
                <FileText size={22} className="text-slate-300 dark:text-slate-600" />
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Pick a file to open it
                </p>
                <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
                  Edits are written straight to this repository&apos;s working copy. Nothing is
                  recorded in git history until you commit.
                </p>
              </div>
            ) : file.content === null ? (
              <UnreadableFile file={file} />
            ) : previewing ? (
              <MarkdownPreview source={content} />
            ) : (
              <Editor
                content={content}
                editorRef={editorRef}
                gutterRef={gutterRef}
                onChange={setContent}
                onKeyDown={onEditorKeyDown}
              />
            )}
          </div>
        </section>

        {showChanges && (
          <aside className="flex max-h-[32rem] min-h-0 w-full shrink-0 flex-col rounded-xl border border-slate-200 bg-white lg:max-h-none lg:w-80 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
              <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Changes {changes.length > 0 && `· ${changes.length}`}
              </span>
              <IconButton title="Hide the changes panel" onClick={() => setShowChanges(false)}>
                <X size={14} />
              </IconButton>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {status === null ? (
                <div className="flex h-24 items-center justify-center">
                  <Spinner size={18} />
                </div>
              ) : changes.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-slate-500 dark:text-slate-400">
                  Nothing has changed since the last commit.
                </div>
              ) : (
                changes.map((change) => (
                  <ChangeRow
                    key={change.path}
                    change={change}
                    active={diffPath === change.path}
                    checked={selected.has(change.path)}
                    onToggle={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(change.path)) next.delete(change.path);
                        else next.add(change.path);
                        return next;
                      })
                    }
                    onShowDiff={() => void openDiff(change.path)}
                    onDiscard={() => void discardChange(change)}
                  />
                ))
              )}
            </div>

            <div className="border-t border-slate-100 p-3 dark:border-slate-800">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={3}
                placeholder="Describe the change…"
                disabled={changes.length === 0}
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  {selected.size} of {changes.length} selected
                </span>
                <Button
                  size="sm"
                  onClick={commit}
                  disabled={committing || changes.length === 0 || !message.trim()}
                >
                  {committing ? <Spinner size={13} /> : <GitCommitHorizontal size={13} />}
                  {committing ? "Committing…" : "Commit"}
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

function fileIconFor(name: string) {
  const ext = extensionOf(name);
  if (isMarkdown(name) || ext === "txt") return <FileText size={13} />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode2 size={13} />;
  return <FileIcon size={13} />;
}

/**
 * One directory level. Children nest inside a padded container rather than
 * computing an indent from a depth counter, which keeps the whole tree free of
 * inline styles no matter how deep it goes.
 */
function TreeLevel({
  path,
  dirs,
  expanded,
  changedPaths,
  activePath,
  onToggle,
  onOpen,
}: {
  path: string;
  dirs: Record<string, RepositoryTreeEntry[]>;
  expanded: Set<string>;
  changedPaths: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const entries = dirs[path];

  if (entries === undefined) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500">
        <Spinner size={12} /> Loading…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500">
        {path ? "Empty folder" : "This repository has no files yet."}
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) =>
        entry.type === "directory" ? (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => onToggle(entry.path)}
              aria-expanded={expanded.has(entry.path)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {expanded.has(entry.path) ? (
                <ChevronDown size={12} className="shrink-0 text-slate-400" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-slate-400" />
              )}
              {expanded.has(entry.path) ? (
                <FolderOpen size={13} className="shrink-0 text-amber-500" />
              ) : (
                <Folder size={13} className="shrink-0 text-amber-500" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {expanded.has(entry.path) && (
              <div className="ml-2.5 border-l border-slate-100 pl-1 dark:border-slate-800">
                <TreeLevel
                  path={entry.path}
                  dirs={dirs}
                  expanded={expanded}
                  changedPaths={changedPaths}
                  activePath={activePath}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </div>
            )}
          </div>
        ) : (
          <button
            key={entry.path}
            type="button"
            onClick={() => onOpen(entry.path)}
            title={entry.path}
            className={
              "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs " +
              (activePath === entry.path
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")
            }
          >
            <span className="w-3 shrink-0" />
            <span className="shrink-0 text-slate-400 dark:text-slate-500">
              {fileIconFor(entry.name)}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {changedPaths.has(entry.path) && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                title="Uncommitted changes"
              />
            )}
          </button>
        ),
      )}
    </>
  );
}

function ChangeRow({
  change,
  active,
  checked,
  onToggle,
  onShowDiff,
  onDiscard,
}: {
  change: RepositoryChange;
  active: boolean;
  checked: boolean;
  onToggle: () => void;
  onShowDiff: () => void;
  onDiscard: () => void;
}) {
  const meta = CHANGE_META[change.status];
  return (
    <div
      className={
        "flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-slate-800 " +
        (active ? "bg-indigo-50/60 dark:bg-indigo-500/10" : "")
      }
    >
      <Checkbox
        checked={checked}
        onChange={onToggle}
        label={`Include ${change.path} in the next commit`}
      />
      <span
        title={change.status}
        className={
          "flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold " +
          meta.className
        }
      >
        {meta.label}
      </span>
      <button
        type="button"
        onClick={onShowDiff}
        title={change.fromPath ? `${change.fromPath} → ${change.path}` : change.path}
        className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-300"
      >
        {change.path}
      </button>
      <button
        type="button"
        onClick={onDiscard}
        title="Discard changes to this file"
        aria-label={`Discard changes to ${change.path}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
      >
        <RotateCcw size={13} />
      </button>
    </div>
  );
}

/**
 * Editor with a gutter that scrolls with the text.
 *
 * `wrap="off"` is what makes the gutter honest: a wrapped line occupies two
 * visual rows but only one number, and the two columns would drift apart the
 * moment anyone opened a file with a long line. Overflowing sideways inside
 * the textarea keeps the page itself from scrolling.
 */
function Editor({
  content,
  editorRef,
  gutterRef,
  onChange,
  onKeyDown,
}: {
  content: string;
  editorRef: React.RefObject<HTMLTextAreaElement>;
  gutterRef: React.RefObject<HTMLDivElement>;
  onChange: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const lineCount = React.useMemo(() => content.split("\n").length, [content]);
  const numbers = React.useMemo(
    () => Array.from({ length: lineCount }, (_value, index) => index + 1),
    [lineCount],
  );

  return (
    <div className="flex h-full min-h-0">
      <div
        ref={gutterRef}
        aria-hidden
        className={
          "h-full shrink-0 overflow-hidden border-r border-slate-100 bg-slate-50 py-3 pr-2 text-right font-mono text-xs leading-5 tabular-nums text-slate-400 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-500 " +
          (lineCount > 9999 ? "w-16" : "w-12")
        }
      >
        {numbers.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <textarea
        ref={editorRef}
        value={content}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        spellCheck={false}
        wrap="off"
        aria-label="File contents"
        className="h-full min-h-0 flex-1 resize-none border-0 bg-transparent px-3 py-3 font-mono text-xs leading-5 text-slate-800 outline-none focus:ring-0 dark:text-slate-100"
      />
    </div>
  );
}

function UnreadableFile({ file }: { file: RepositoryFileContent }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <FileIcon size={22} className="text-slate-300 dark:text-slate-600" />
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {file.binary ? "This file is binary" : "This file is too large to edit here"}
      </p>
      <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
        {file.binary
          ? "Genosyn only opens text in the browser editor. The file is still in the repository and AI employees can work with it through their checkout."
          : `It is ${Math.round(file.size / 1024)} KB. Editing a file that size in a browser textarea would be slower than useful, so the editor stays out of the way. It is still in the repository, and an AI employee can work on it.`}
      </p>
    </div>
  );
}

/**
 * Markdown preview for a checked-in `.md`.
 *
 * `breaks` is deliberately off, unlike the chat renderer: source files are
 * hard-wrapped, and treating every newline as a line break would shred a
 * paragraph that reads fine on GitHub. Sanitizing is not optional — the text
 * is whatever happens to be committed in the repository.
 */
function MarkdownPreview({ source }: { source: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(source ?? "", { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(raw);
  }, [source]);

  if (!source.trim()) {
    return (
      <div className="px-6 py-14 text-center text-xs text-slate-500 dark:text-slate-400">
        This file is empty.
      </div>
    );
  }

  return (
    <div
      className="chat-md break-words px-5 py-4 text-sm"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
