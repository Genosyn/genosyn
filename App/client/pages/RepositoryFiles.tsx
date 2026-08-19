import React from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  File as FileIcon,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCommitHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Upload,
  X,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { useNavigationGuard } from "../components/NavigationGuard";
import { BranchPicker } from "../components/repositories/BranchPicker";
import { DiffView } from "../components/repositories/DiffView";
import {
  CODE_LINE_HEIGHT_PX,
  CODE_TYPOGRAPHY,
  HighlightedCode,
  MAX_HIGHLIGHT_CHARS,
} from "../components/repositories/HighlightedCode";
import { MarkdownPreview } from "../components/repositories/MarkdownPreview";
import { languageForPath } from "../components/repositories/highlight";
import {
  api,
  RepositoryBranch,
  RepositoryBranchesResponse,
  RepositoryChange,
  RepositoryChangeStatus,
  RepositoryCommitResult,
  RepositoryDiff,
  RepositoryFileContent,
  RepositorySearchMatch,
  RepositorySearchResponse,
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

/** Long enough that a fast typist never fires a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 200;
/** Two characters is the point where a substring search stops matching everything. */
const SEARCH_MIN_CHARS = 2;

/**
 * Quick open needs every path, and the tree endpoint answers one directory at a
 * time, so the index is crawled on first use, cached, and dropped only when
 * something could actually have changed the set of paths — a commit cannot, so
 * committing does not cost a re-crawl.
 *
 * Each listing costs the server a git call, hence the modest concurrency and
 * the caps. Git-ignored directories are already left out server-side, which is
 * what makes an ordinary repository fit well inside them.
 */
const INDEX_CONCURRENCY = 4;
const MAX_INDEXED_DIRECTORIES = 150;
const MAX_INDEXED_FILES = 4000;
const QUICK_OPEN_LIMIT = 50;

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

const EMPTY_STATUS: RepositoryStatus = {
  branch: null,
  unborn: false,
  detached: false,
  ahead: 0,
  behind: 0,
  upstream: null,
  changes: [],
};

/**
 * Words, not git's porcelain letters. `DiffView` has always labelled the same
 * six states this way, and a column of `A M D R U !` means nothing at all to
 * someone whose repository holds policies rather than source.
 */
const CHANGE_META: Record<RepositoryChangeStatus, { label: string; className: string }> = {
  added: {
    label: "New",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  modified: {
    label: "Edited",
    className: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  },
  deleted: {
    label: "Deleted",
    className: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  },
  renamed: {
    label: "Renamed",
    className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  untracked: {
    label: "New",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  conflicted: {
    label: "Conflict",
    className: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",
  },
};

/** Long-form wording for the same six states, used in titles and dialogs. */
const CHANGE_DESCRIPTION: Record<RepositoryChangeStatus, string> = {
  added: "Added since the last commit",
  modified: "Edited since the last commit",
  deleted: "Deleted since the last commit",
  renamed: "Moved or renamed since the last commit",
  untracked: "Added since the last commit",
  conflicted: "Two versions disagree and someone has to pick",
};

/**
 * The server rejects a longer message, and it does it with a schema error that
 * reads as `ValidationError`. Stopping the typing at the same number is the
 * only way the limit is ever explained.
 */
const MAX_COMMIT_MESSAGE_CHARS = 2000;
/** Matches `MAX_EDITABLE_FILE_BYTES` on the server. */
const MAX_EDITABLE_FILE_BYTES = 256 * 1024;
/** The server's cap on a repository-relative path. */
const MAX_PATH_CHARS = 1000;
/** The server's cap on a branch name. */
const MAX_BRANCH_NAME_CHARS = 200;

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
  if (trimmed.length > MAX_PATH_CHARS) {
    return `That path is too long — keep it under ${MAX_PATH_CHARS} characters.`;
  }
  return null;
}

/**
 * The editor works in `\n` only, because a textarea does: the DOM normalizes
 * every `\r\n` it is handed, so a file committed with Windows endings would
 * leave `content` and the textarea disagreeing about every line break. Offsets
 * computed from one and applied to the other land in the wrong place, and the
 * first keystroke would rewrite every line ending in the file. So the ending is
 * detected on read, stripped, and put back on save.
 */
type LineEnding = "\n" | "\r\n";

function detectLineEnding(source: string): LineEnding {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function toEditorText(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

function toFileText(source: string, ending: LineEnding): string {
  return ending === "\n" ? source : source.replace(/\n/g, "\r\n");
}

export default function RepositoryFiles() {
  const { company, repo } = useRepositoriesContext();
  const { toast } = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();
  const navigationGuard = useNavigationGuard();

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
  /** Set on a successful save, so "Saved" can mean something someone just did. */
  const [justSaved, setJustSaved] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);

  const [diffPath, setDiffPath] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<RepositoryDiff | null>(null);

  const [showChanges, setShowChanges] = React.useState(true);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [message, setMessage] = React.useState("");
  const [committing, setCommitting] = React.useState(false);

  const [showIgnored, setShowIgnored] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<RepositorySearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = React.useState(false);

  const [quickOpen, setQuickOpen] = React.useState(false);
  const [fileIndex, setFileIndex] = React.useState<{
    paths: string[];
    truncated: boolean;
  } | null>(null);
  const [indexing, setIndexing] = React.useState(false);

  const editorRef = React.useRef<HTMLTextAreaElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const caretRef = React.useRef<number | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // The tree reload has to re-fetch exactly the directories already on screen,
  // and reading them from state would make every callback churn.
  const dirsRef = React.useRef(dirs);
  dirsRef.current = dirs;
  // Read through a ref so toggling "show ignored" does not change `loadDir`'s
  // identity — the mount effect keys off that, and re-running it would close
  // whatever file is open.
  const showIgnoredRef = React.useRef(showIgnored);
  showIgnoredRef.current = showIgnored;
  // Guards against a slow file response landing after a faster later one.
  const openTokenRef = React.useRef(0);
  const searchTokenRef = React.useRef(0);
  // Switching repositories mid-crawl must not let the previous repository's
  // paths land in the index someone is about to search.
  const indexTokenRef = React.useRef(0);
  /**
   * Set when a file is opened from a search hit, consumed once it has loaded.
   * Only {@link openFile} writes it, from its own argument — every other route
   * into the editor would otherwise inherit a line number it never asked for.
   */
  const revealLineRef = React.useRef<number | null>(null);
  /** The line ending the open file arrived with; restored on every save. */
  const eolRef = React.useRef<LineEnding>("\n");

  const loadDir = React.useCallback(
    async (path: string) => {
      if (!base) return;
      const ignoredParam = showIgnoredRef.current ? "&showIgnored=1" : "";
      try {
        const response = await api.get<RepositoryTreeResponse>(
          `${base}/workspace/tree?path=${encodeURIComponent(path)}${ignoredParam}`,
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
    setSearchOpen(false);
    setSearchQuery("");
    // Abandon a crawl still in flight for the previous repository, and clear the
    // flag it would otherwise have been left holding.
    indexTokenRef.current += 1;
    setIndexing(false);
    setFileIndex(null);
    loadDir("");
    reloadStatus();
  }, [base, loadDir, reloadStatus]);

  useLiveRefetch("repository", reloadStatus, repoId);

  // Only the toggle itself should re-list; comparing against the previous value
  // keeps a repository switch from fetching the whole tree twice.
  const previousShowIgnored = React.useRef(showIgnored);
  React.useEffect(() => {
    if (previousShowIgnored.current === showIgnored) return;
    previousShowIgnored.current = showIgnored;
    void reloadTree();
  }, [showIgnored, reloadTree]);

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

  /**
   * Load a file into the editor.
   *
   * `revealLine` and `raw` are arguments rather than ambient state because the
   * losing half of a race must not be able to touch either: every decision this
   * makes is re-checked against the token before it is applied, so a slow open
   * that has already been superseded changes nothing at all.
   */
  const openFile = React.useCallback(
    async (path: string, options: { revealLine?: number; raw?: boolean } = {}) => {
      if (!base) return;
      const token = openTokenRef.current + 1;
      openTokenRef.current = token;
      revealLineRef.current = null;
      setDiffPath(null);
      setDiff(null);
      setOpenPath(path);
      setFile(null);
      setSavedContent(null);
      setJustSaved(false);
      setFileLoading(true);
      try {
        const row = await api.get<RepositoryFileContent>(
          `${base}/workspace/file?path=${encodeURIComponent(path)}`,
        );
        if (openTokenRef.current !== token) return;
        const raw = row.content ?? "";
        eolRef.current = detectLineEnding(raw);
        const normalized = toEditorText(raw);
        setFile(row.content === null ? row : { ...row, content: normalized });
        setContent(normalized);
        setSavedContent(row.content === null ? null : normalized);
        // A search hit is about one line of source, so it opens the editor even
        // in a documents repository where markdown would otherwise render.
        setPreviewing(!options.raw && isMarkdown(path) && documentsFirst);
        if (options.revealLine !== undefined && row.content !== null) {
          revealLineRef.current = options.revealLine;
        }
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
  // The navigation guard is registered once and has to keep answering
  // correctly; reading these through refs means a keystroke does not
  // re-register it.
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  const openPathRef = React.useRef(openPath);
  openPathRef.current = openPath;

  const save = React.useCallback(async () => {
    if (!base || !openPath || savedContent === null || content === savedContent || saving) return;
    const payload = toFileText(content, eolRef.current);
    // The server's schema counts UTF-16 units and its writer counts bytes, so
    // the only limit that means anything to a person is checked here first.
    if (new TextEncoder().encode(payload).length > MAX_EDITABLE_FILE_BYTES) {
      toast(
        `This file has grown past ${Math.round(MAX_EDITABLE_FILE_BYTES / 1024)} KB, which is more than the browser editor saves. Trim it, or split it in two.`,
        "error",
      );
      return;
    }
    setSaving(true);
    try {
      await api.put(`${base}/workspace/file`, { path: openPath, content: payload });
      setSavedContent(content);
      setJustSaved(true);
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

  // Closing the tab is a way out of this page like any other, and the in-page
  // confirmation cannot reach it. Same guard the other editor pages use.
  React.useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  const confirmLeavingUnsaved = React.useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    return dialog.confirm({
      title: "Leave without saving?",
      message: `${openPathRef.current ?? "This file"} has edits that have not been saved yet. Leaving now loses them.`,
      confirmLabel: "Leave without saving",
      variant: "danger",
    });
  }, [dialog]);
  const confirmLeavingRef = React.useRef(confirmLeavingUnsaved);
  confirmLeavingRef.current = confirmLeavingUnsaved;

  /**
   * Leaving the page is the other way to lose unsaved edits, and the in-page
   * confirmation cannot see it happen. Two halves are needed: the shared guard
   * covers browser Back / Forward and programmatic navigation, and a capture
   * listener covers the ordinary links in the sidebar, which go straight to the
   * router. Both end in the same question.
   */
  React.useLayoutEffect(
    () =>
      navigationGuard.register(
        (destination, onAllowed, request) => {
          if (!dirtyRef.current) return false;
          if (request?.source === "history") {
            // A history restore is already in flight; an async dialog would
            // race it, so this one question is asked synchronously.
            if (!window.confirm("Leave this file? Edits you have not saved will be lost.")) {
              request.cancel();
              return true;
            }
            onAllowed?.();
            return true;
          }
          void confirmLeavingRef.current().then((ok) => {
            if (!ok) return;
            if (onAllowed) onAllowed();
            else navigate(destination);
          });
          return true;
        },
        () => dirtyRef.current,
      ),
    [navigate, navigationGuard],
  );

  React.useEffect(() => {
    function interceptLink(event: MouseEvent) {
      if (!dirtyRef.current) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void confirmLeavingRef.current().then((ok) => {
        if (ok) navigate(`${destination.pathname}${destination.search}${destination.hash}`);
      });
    }
    document.addEventListener("click", interceptLink, true);
    return () => document.removeEventListener("click", interceptLink, true);
  }, [navigate]);

  // Tab inserts spaces rather than moving focus, so the caret has to be put
  // back by hand once React has re-rendered the textarea with the new value.
  React.useEffect(() => {
    const caret = caretRef.current;
    if (caret === null || !editorRef.current) return;
    editorRef.current.selectionStart = caret;
    editorRef.current.selectionEnd = caret;
    caretRef.current = null;
  }, [content]);

  // Landing on the matched line is the whole point of clicking a search hit;
  // dropping someone at the top of a 2000-line file is barely better than not
  // opening it at all.
  React.useEffect(() => {
    const line = revealLineRef.current;
    if (line === null || file === null || file.content === null) return;
    const element = editorRef.current;
    if (!element) return;
    revealLineRef.current = null;
    const lines = file.content.split("\n");
    const target = Math.min(Math.max(line, 1), lines.length);
    let offset = 0;
    for (let index = 0; index < target - 1; index += 1) offset += lines[index].length + 1;
    element.focus();
    element.setSelectionRange(offset, offset + lines[target - 1].length);
    element.scrollTop = Math.max(0, (target - 1) * CODE_LINE_HEIGHT_PX - element.clientHeight / 2);
  }, [file, previewing]);

  React.useEffect(() => {
    const term = searchQuery.trim();
    if (!base || !searchOpen || term.length < SEARCH_MIN_CHARS) {
      searchTokenRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const handle = window.setTimeout(() => {
      const token = searchTokenRef.current + 1;
      searchTokenRef.current = token;
      api
        .get<RepositorySearchResponse>(
          `${base}/workspace/search?q=${encodeURIComponent(term)}&limit=${SEARCH_LIMIT}`,
        )
        .then((response) => {
          if (searchTokenRef.current !== token) return;
          setSearchResults(response);
          setSearchLoading(false);
        })
        .catch((err: unknown) => {
          if (searchTokenRef.current !== token) return;
          toast(err instanceof Error ? err.message : String(err), "error");
          setSearchResults({ matches: [], truncated: false });
          setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
      // Cancelling the timer is not enough: a request for the previous term may
      // already be in the air, and without bumping the token it would land and
      // present itself as the final count for a term nobody is searching for.
      searchTokenRef.current += 1;
    };
  }, [base, searchOpen, searchQuery, toast]);

  const searchGroups = React.useMemo(() => {
    const groups = new Map<string, RepositorySearchMatch[]>();
    for (const match of searchResults?.matches ?? []) {
      const bucket = groups.get(match.path);
      if (bucket) bucket.push(match);
      else groups.set(match.path, [match]);
    }
    return [...groups.entries()].map(([path, matches]) => ({ path, matches }));
  }, [searchResults]);

  const buildFileIndex = React.useCallback(async () => {
    if (!base) return;
    // A crawl is many round trips; switching repositories part-way through has
    // to abandon it, or the previous repository's paths land in quick open.
    const token = indexTokenRef.current + 1;
    indexTokenRef.current = token;
    setIndexing(true);
    const paths: string[] = [];
    const queue: string[] = [""];
    let directoriesRead = 0;
    let capped = false;
    try {
      while (queue.length > 0) {
        if (directoriesRead >= MAX_INDEXED_DIRECTORIES || paths.length >= MAX_INDEXED_FILES) {
          capped = true;
          break;
        }
        const batch = queue.splice(0, INDEX_CONCURRENCY);
        directoriesRead += batch.length;
        const responses = await Promise.all(
          batch.map((path) =>
            api
              .get<RepositoryTreeResponse>(
                `${base}/workspace/tree?path=${encodeURIComponent(path)}`,
              )
              // One unreadable directory should cost that directory, not the index.
              .catch(() => null),
          ),
        );
        if (indexTokenRef.current !== token) return;
        for (const response of responses) {
          if (!response) continue;
          for (const entry of response.entries) {
            // Quick open is for files someone would edit, so ignored paths stay
            // out of it whatever the tree is currently showing.
            if (entry.ignored) continue;
            if (entry.type === "directory") queue.push(entry.path);
            else paths.push(entry.path);
          }
        }
      }
      paths.sort((a, b) => a.localeCompare(b));
      setFileIndex({ paths, truncated: capped });
    } finally {
      if (indexTokenRef.current === token) setIndexing(false);
    }
  }, [base]);

  React.useEffect(() => {
    if (quickOpen && fileIndex === null && !indexing) void buildFileIndex();
  }, [buildFileIndex, fileIndex, indexing, quickOpen]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key !== "p" && event.key !== "P") return;
      event.preventDefault();
      setQuickOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  async function selectFile(path: string) {
    if (path === openPath && !diffPath) return;
    if (!(await confirmLeavingUnsaved())) return;
    await openFile(path);
  }

  async function openSearchMatch(match: RepositorySearchMatch) {
    if (!(await confirmLeavingUnsaved())) return;
    // Both the line to land on and "show the source, not the rendered view" go
    // in as arguments, so a slower search hit that has already been overtaken
    // cannot reach back and change what the newer file is showing.
    await openFile(match.path, { revealLine: match.line, raw: true });
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
  }

  function toggleSearch() {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
    // The pane is narrow and the input appears below the header, so focusing it
    // is the difference between one click and two.
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
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
      setFileIndex(null);
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
      setFileIndex(null);
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
      validate: (value) => {
        const trimmed = value.trim();
        if (!/^[A-Za-z0-9._][A-Za-z0-9._\-/]*$/.test(trimmed)) {
          return "Letters, numbers, dot, dash, underscore, and slash only.";
        }
        if (trimmed.length > MAX_BRANCH_NAME_CHARS) {
          return `Keep the name under ${MAX_BRANCH_NAME_CHARS} characters.`;
        }
        return null;
      },
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

  /**
   * Bring the remote's commits down. Refresh only fetches, so without this the
   * only way out of "2 commits behind" was to ask someone with a terminal.
   */
  async function pull() {
    const branch = currentStatus?.branch;
    if (!branch) {
      toast("Check out a branch before pulling.", "error");
      return;
    }
    if (!(await confirmLeavingUnsaved())) return;
    setBusy(true);
    try {
      await api.post(`${base}/workspace/pull`, { name: branch });
      await Promise.all([reloadStatus(), reloadTree()]);
      setFileIndex(null);
      if (openPath) await openFile(openPath);
      toast(`Updated ${branch} from the remote`, "success");
    } catch (err) {
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
      setFileIndex(null);
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
      // Discarding an untracked file deletes it, so the path list can shrink.
      setFileIndex(null);
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
    // The button is disabled in both of these cases, so reaching here means a
    // stray keypress rather than a person to explain anything to.
    if (!message.trim() || selected.size === 0) return;
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
    const next = content.slice(0, start) + "  " + content.slice(end);
    // Replacing exactly two spaces with two spaces produces an identical
    // string, React skips the re-render, and the restore effect never runs. A
    // caret offset left behind would be applied to the *next* edit instead,
    // yanking the caret mid-typing — so this case is finished here and now.
    if (next === content) {
      element.setSelectionRange(start + 2, start + 2);
      return;
    }
    setContent(next);
    caretRef.current = start + 2;
  }

  return (
    <div className="pb-12">
      <div className="mb-5 flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
          <FileCode2 size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Files
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Read and edit everything in {currentRepo.name}. Saving keeps your work here; it joins
            the history when you commit.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <BranchPicker
          status={currentStatus}
          branches={branches}
          defaultBranch={currentRepo.defaultBranch}
          disabled={busy}
          onCheckout={(name) => void checkout(name)}
          onCreateBranch={() => void createBranch()}
        />

        {currentStatus && (currentStatus.ahead > 0 || currentStatus.behind > 0) && (
          <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[11px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {currentStatus.ahead > 0 && (
              <span
                title={`${currentStatus.ahead} ${currentStatus.ahead === 1 ? "commit" : "commits"} here that the remote does not have yet`}
              >
                ↑{currentStatus.ahead}
              </span>
            )}
            {currentStatus.behind > 0 && (
              <span
                title={`${currentStatus.behind} ${currentStatus.behind === 1 ? "commit" : "commits"} on the remote that this copy does not have yet`}
              >
                ↓{currentStatus.behind}
              </span>
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
          <Button
            size="sm"
            variant="secondary"
            onClick={refresh}
            disabled={busy}
            title={
              isRemote
                ? "Ask the git host what has changed, and re-read this copy"
                : "Re-read this copy from disk"
            }
          >
            {busy ? <Spinner size={14} /> : <RefreshCw size={14} />}
            {isRemote ? "Check for updates" : "Reload"}
          </Button>
          {isRemote && (
            <Button
              size="sm"
              variant="secondary"
              onClick={pull}
              disabled={busy}
              title="Bring down commits made on the remote"
            >
              <Download size={14} />
              {currentStatus && currentStatus.behind > 0 ? `Pull ${currentStatus.behind}` : "Pull"}
            </Button>
          )}
          {isRemote && (
            <Button
              size="sm"
              onClick={push}
              disabled={busy}
              title="Send your commits to the remote"
            >
              <Upload size={14} />
              {currentStatus && currentStatus.ahead > 0 ? `Push ${currentStatus.ahead}` : "Push"}
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
            <IconButton
              title={searchOpen ? "Close search" : "Search inside these files"}
              active={searchOpen}
              onClick={toggleSearch}
            >
              <Search size={14} />
            </IconButton>
            <IconButton title="New file" onClick={() => createEntry("file")}>
              <FilePlus2 size={14} />
            </IconButton>
            <IconButton title="New folder" onClick={() => createEntry("directory")}>
              <FolderPlus size={14} />
            </IconButton>
            {/* No second refresh here: the toolbar button above already
              re-reads the tree, and two identical icons a few inches apart
              meaning different things is worse than one that means both. */}
          </div>

          {searchOpen && (
            <div className="border-b border-slate-100 p-2 dark:border-slate-800">
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  // First Escape clears, second one puts the tree back — the
                  // same two-step every editor's find box uses.
                  if (searchQuery) setSearchQuery("");
                  else closeSearch();
                }}
                placeholder="Find text in this repository…"
                aria-label="Find text in this repository"
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {searchOpen && searchQuery.trim().length >= SEARCH_MIN_CHARS ? (
              <SearchResults
                loading={searchLoading}
                results={searchResults}
                groups={searchGroups}
                activePath={openPath}
                onOpen={(match) => void openSearchMatch(match)}
              />
            ) : searchOpen ? (
              <div className="px-2 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                Type at least {SEARCH_MIN_CHARS} characters.
              </div>
            ) : (
              <TreeLevel
                path=""
                dirs={dirs}
                expanded={expanded}
                changedPaths={changedPaths}
                activePath={openPath}
                onToggle={toggleDirectory}
                onOpen={selectFile}
                onCreateFile={() => createEntry("file")}
              />
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 border-t border-slate-100 px-2.5 py-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <Checkbox
              checked={showIgnored}
              onChange={() => setShowIgnored((current) => !current)}
              label="Show build output and other hidden files"
            />
            Show hidden files
          </label>
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
                    {/* "Saved" on a file nobody has touched confirms nothing.
                      The resting state and the just-did-it state have to read
                      differently or the word is decoration. */}
                    {saving
                      ? "Saving…"
                      : dirty
                        ? "Unsaved changes"
                        : justSaved
                          ? "Saved just now"
                          : "No changes"}
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
                    // One file, opened deliberately from the tree. A summary
                    // header over a single collapsed row would be a click
                    // between someone and the thing they just asked to see.
                    expanded
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
                  Open a file to start editing
                </p>
                <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
                  Pick something on the left, or jump straight to it with {MOD_KEY}P.
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setQuickOpen(true)}>
                    <Search size={13} /> Go to file
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => createEntry("file")}>
                    <FilePlus2 size={13} /> New file
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                  {MOD_KEY}P jumps to a file · {MOD_KEY}S saves
                </p>
              </div>
            ) : file.content === null ? (
              <UnreadableFile file={file} />
            ) : previewing ? (
              <MarkdownPreview source={content} />
            ) : (
              <Editor
                content={content}
                language={languageForPath(openPath)}
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
                  Nothing has changed since the last commit. Edit and save a file and it will show
                  up here.
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
                // The server rejects anything longer with a schema error that
                // reads as the literal word "ValidationError", so the limit is
                // enforced where it can still be understood.
                maxLength={MAX_COMMIT_MESSAGE_CHARS}
                placeholder="Describe the change…"
                aria-label="What changed"
                disabled={changes.length === 0}
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                {/* The count used to be inert text beside thirty checkboxes;
                  as a control it is the difference between one click and
                  twenty-nine. */}
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <Checkbox
                    checked={selected.size === changes.length && changes.length > 0}
                    indeterminate={selected.size > 0 && selected.size < changes.length}
                    disabled={changes.length === 0}
                    onChange={() =>
                      setSelected(
                        selected.size === changes.length
                          ? new Set()
                          : new Set(changes.map((change) => change.path)),
                      )
                    }
                    label="Include every changed file in the next commit"
                  />
                  {selected.size} of {changes.length} files
                </label>
                <Button
                  size="sm"
                  onClick={commit}
                  disabled={committing || selected.size === 0 || !message.trim()}
                >
                  {committing ? <Spinner size={13} /> : <GitCommitHorizontal size={13} />}
                  {committing ? "Committing…" : "Commit"}
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>

      <QuickOpen
        open={quickOpen}
        indexing={indexing}
        index={fileIndex}
        onClose={() => setQuickOpen(false)}
        onOpen={(path) => {
          setQuickOpen(false);
          void selectFile(path);
        }}
      />
    </div>
  );
}

function IconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  /** Omitted entirely for plain buttons, so only real toggles report a state. */
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md " +
        (active
          ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200")
      }
    >
      {children}
    </button>
  );
}

/**
 * Results of a text search, grouped by file. Each row is a line, not a file:
 * "which of the eleven hits in this file did I mean" is the question the flat
 * list of paths every basic search returns cannot answer.
 */
function SearchResults({
  loading,
  results,
  groups,
  activePath,
  onOpen,
}: {
  loading: boolean;
  results: RepositorySearchResponse | null;
  groups: { path: string; matches: RepositorySearchMatch[] }[];
  activePath: string | null;
  onOpen: (match: RepositorySearchMatch) => void;
}) {
  if (loading && results === null) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner size={16} />
      </div>
    );
  }
  if (results === null) return null;
  if (groups.length === 0) {
    return (
      <div className="px-2 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
        Nothing in this repository matches.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1.5 pt-1 text-[10px] text-slate-400 dark:text-slate-500">
        {/* The previous results stay on screen while the next ones load, so the
          pane does not blink on every keystroke — the label says which it is. */}
        {loading
          ? "Searching…"
          : `${results.matches.length} ${results.matches.length === 1 ? "line" : "lines"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`}
      </div>
      {groups.map((group) => (
        <div key={group.path}>
          <div
            title={group.path}
            className={
              "truncate px-1.5 py-0.5 font-mono text-[10px] " +
              (activePath === group.path
                ? "text-indigo-600 dark:text-indigo-300"
                : "text-slate-400 dark:text-slate-500")
            }
          >
            {group.path}
          </div>
          {group.matches.map((match) => (
            <button
              key={`${match.path}:${match.line}`}
              type="button"
              onClick={() => onOpen(match)}
              title={match.text.trim()}
              className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
                {match.line}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300">
                {match.text.trim() || " "}
              </span>
            </button>
          ))}
        </div>
      ))}
      {results.truncated && (
        <div className="px-2 pb-2 text-center text-[10px] text-slate-400 dark:text-slate-500">
          Showing the first {results.matches.length} matches. Add another word to narrow it down.
        </div>
      )}
    </div>
  );
}

function rankPaths(paths: string[], query: string): string[] {
  const term = query.trim().toLowerCase();
  if (!term) return paths.slice(0, QUICK_OPEN_LIMIT);
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const at = lower.indexOf(term);
    if (at === -1) continue;
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    // Someone typing a few letters almost always means a file name, so a hit
    // anywhere in the directory part sorts below every hit in a name.
    scored.push({ path, score: (name.includes(term) ? 0 : 1000) + at + path.length / 1000 });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, QUICK_OPEN_LIMIT).map((row) => row.path);
}

/**
 * Jump straight to a file by typing part of its path. The tree is fine for
 * exploring and hopeless for "open the thing I already know the name of", which
 * is what most visits to this page actually are.
 */
function QuickOpen({
  open,
  indexing,
  index,
  onClose,
  onOpen,
}: {
  open: boolean;
  indexing: boolean;
  index: { paths: string[]; truncated: boolean } | null;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const matches = React.useMemo(() => rankPaths(index?.paths ?? [], query), [index, query]);

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  React.useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const path = matches[active];
      if (path) onOpen(path);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Go to file">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Start typing a file name…"
        aria-label="File name"
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
      />

      <div className="mt-3 max-h-72 overflow-y-auto">
        {index === null ? (
          <div className="flex h-24 items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Spinner size={14} /> {indexing ? "Reading the file list…" : "Getting ready…"}
          </div>
        ) : matches.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            {index.paths.length === 0
              ? "This repository has no files yet."
              : "No file name matches that."}
          </div>
        ) : (
          matches.map((path, position) => {
            const cut = path.lastIndexOf("/");
            return (
              <button
                key={path}
                type="button"
                onClick={() => onOpen(path)}
                onMouseEnter={() => setActive(position)}
                className={
                  "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left " +
                  (position === active
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800/60")
                }
              >
                <span className="shrink-0 text-slate-400 dark:text-slate-500">
                  {fileIconFor(path)}
                </span>
                <span className="truncate text-sm text-slate-800 dark:text-slate-100">
                  {cut === -1 ? path : path.slice(cut + 1)}
                </span>
                {cut !== -1 && (
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-slate-400 dark:text-slate-500">
                    {path.slice(0, cut)}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {index?.truncated && (
        <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
          This repository is large, so only the first {index.paths.length} files are listed here.
          Use the tree for the rest.
        </p>
      )}
    </Modal>
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
  onCreateFile,
}: {
  path: string;
  dirs: Record<string, RepositoryTreeEntry[]>;
  expanded: Set<string>;
  changedPaths: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onCreateFile: () => void;
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
    if (path) {
      return <div className="px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500">Empty</div>;
    }
    return (
      <div className="px-2 py-6 text-center">
        <p className="text-xs text-slate-500 dark:text-slate-400">No files yet.</p>
        <button
          type="button"
          onClick={onCreateFile}
          className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
        >
          Create the first one
        </button>
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
              title={entry.ignored ? `${entry.path} — ignored by git` : entry.path}
              className={
                "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 " +
                (entry.ignored
                  ? "text-slate-400 dark:text-slate-500"
                  : "text-slate-700 dark:text-slate-200")
              }
            >
              {expanded.has(entry.path) ? (
                <ChevronDown size={12} className="shrink-0 text-slate-400" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-slate-400" />
              )}
              {expanded.has(entry.path) ? (
                <FolderOpen
                  size={13}
                  className={"shrink-0 " + (entry.ignored ? "text-slate-300" : "text-amber-500")}
                />
              ) : (
                <Folder
                  size={13}
                  className={"shrink-0 " + (entry.ignored ? "text-slate-300" : "text-amber-500")}
                />
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
                  onCreateFile={onCreateFile}
                />
              </div>
            )}
          </div>
        ) : (
          <button
            key={entry.path}
            type="button"
            onClick={() => onOpen(entry.path)}
            title={entry.ignored ? `${entry.path} — ignored by git` : entry.path}
            className={
              "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs " +
              (activePath === entry.path
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                : entry.ignored
                  ? "text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-800"
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
                title="Not committed yet"
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
        title={CHANGE_DESCRIPTION[change.status]}
        className={
          "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium " +
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
 * Editor with a gutter that scrolls with the text and a colour layer under it.
 *
 * `wrap="off"` is what makes the gutter honest: a wrapped line occupies two
 * visual rows but only one number, and the two columns would drift apart the
 * moment anyone opened a file with a long line. Overflowing sideways inside
 * the textarea keeps the page itself from scrolling.
 *
 * The highlighting is a `<pre>` behind a textarea whose own text is
 * transparent. Both use {@link CODE_TYPOGRAPHY}, and the overlay is moved with
 * a transform rather than its own scroll offset — a scroll container's maximum
 * offset depends on which scrollbars it has, and the two elements do not have
 * the same ones. Where the language is unknown, or the file is big enough that
 * tokenizing on every keystroke would be felt, the overlay is simply not
 * rendered and the textarea paints its own text: no colour is much better than
 * colour half a line out of place.
 */
function Editor({
  content,
  language,
  editorRef,
  gutterRef,
  onChange,
  onKeyDown,
}: {
  content: string;
  language: string;
  editorRef: React.RefObject<HTMLTextAreaElement>;
  gutterRef: React.RefObject<HTMLDivElement>;
  onChange: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const overlayRef = React.useRef<HTMLPreElement>(null);
  const lineCount = React.useMemo(() => content.split("\n").length, [content]);
  // One `<div>` per line is 130 000 elements on a large file, rebuilt on every
  // keystroke. A single pre-formatted text node lays out identically — the
  // gutter shares the editor's line height — and costs one node.
  const numbers = React.useMemo(() => {
    const rows: string[] = [];
    for (let line = 1; line <= lineCount; line += 1) rows.push(String(line));
    return rows.join("\n");
  }, [lineCount]);
  const coloured = language !== "plain" && content.length <= MAX_HIGHLIGHT_CHARS;

  const syncScroll = React.useCallback(() => {
    const element = editorRef.current;
    if (!element) return;
    if (gutterRef.current) gutterRef.current.scrollTop = element.scrollTop;
    if (overlayRef.current) {
      overlayRef.current.style.transform = `translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`;
    }
  }, [editorRef, gutterRef]);

  // Opening a file re-uses the same textarea, so it can start at whatever offset
  // the previous one was left at before the browser reports a scroll.
  React.useLayoutEffect(syncScroll, [syncScroll, content, coloured]);

  return (
    <div className="flex h-full min-h-0">
      <div
        ref={gutterRef}
        aria-hidden
        className={
          "h-full shrink-0 overflow-hidden whitespace-pre border-r border-slate-100 bg-slate-50 py-3 pr-2 text-right font-mono text-xs leading-5 tabular-nums text-slate-400 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-500 " +
          (lineCount > 9999 ? "w-16" : "w-12")
        }
      >
        {numbers}
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {coloured && <HighlightedCode ref={overlayRef} source={content} language={language} />}
        <textarea
          ref={editorRef}
          value={content}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          spellCheck={false}
          wrap="off"
          aria-label="File contents"
          className={
            "absolute inset-0 h-full w-full resize-none border-0 bg-transparent outline-none focus:ring-0 " +
            CODE_TYPOGRAPHY +
            " " +
            (coloured
              ? "text-transparent caret-slate-800 selection:bg-indigo-300/40 dark:caret-slate-100 dark:selection:bg-indigo-400/30"
              : "text-slate-800 dark:text-slate-100")
          }
        />
      </div>
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
