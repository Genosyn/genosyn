import * as React from "react";
import { Link } from "react-router-dom";
import { FolderGit2, Maximize2, X } from "lucide-react";
import { api, Repository, RepositoryStatus } from "../lib/api";
import { repositoryWorkHref, type RepositoryWorkTarget } from "../lib/repositoryWorkLink";
import { useLiveRefetch } from "./CompanySocket";
import { SessionPane } from "./repositories/SessionPane";
import { InlineRetry } from "./repositories/sessionChrome";
import { isGithubRemote } from "./repositories/sessionState";
import {
  SidePanelCollapseIcon,
  SidePanelResizeHandle,
  useSidePanelWidth,
  useWideViewport,
} from "./ui/SidePanel";
import { SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT } from "./ui/sidePanelWidth";
import { Spinner } from "./ui/Spinner";
import { useDialog } from "./ui/Dialog";
import { useToast } from "./ui/Toast";

/**
 * A Repository work session, docked beside the conversation that started it.
 *
 * An AI Employee that starts repository work replies with a link to the
 * session. Following it used to leave the thread — the reader was moved into
 * the Repository section to look at a diff and had to navigate back to say
 * what they thought of it. Chat opens the session here instead, on the same
 * seam the live browser uses, so reviewing the work and talking about it are
 * the same screen.
 *
 * The workbench itself is `SessionPane`, shared verbatim with the Repository
 * page: same transcript, same diff, and — the part that must never fork — the
 * same rules about which of accept / send / open a pull request / throw away
 * a Member is offered.
 */

type Props = {
  companyId: string;
  companySlug: string;
  companyRole?: "owner" | "admin" | "member";
  currentUserId: string;
  target: RepositoryWorkTarget;
  /**
   * Owned by chat, not by this component: clicking a work-session link cancels
   * the link's navigation before the panel is involved, so a collapsed panel
   * that kept its own state would answer that click with nothing at all.
   */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onClose: () => void;
};

const PANEL_WIDTH_STORAGE_KEY = "genosyn.repositoryWorkPanel.width";

/**
 * Below this, the app's two rails, a readable conversation, and a readable
 * panel do not all fit, so the panel takes the screen instead of turning the
 * conversation into a sliver. Chat reads it too: taking the screen is fine
 * when someone asked for it and rude when work merely started. The number
 * comes from the same arithmetic the width clamp uses, so the two cannot
 * disagree about what fits.
 */
export const WORK_PANEL_MIN_SIDE_BY_SIDE = SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT;

export function RepositoryWorkPanel({
  companyId,
  companySlug,
  companyRole,
  currentUserId,
  target,
  collapsed,
  onCollapsedChange,
  onClose,
}: Props) {
  const { width, resizing, startResize, onResizeKeyDown } =
    useSidePanelWidth(PANEL_WIDTH_STORAGE_KEY);
  const wide = useWideViewport(WORK_PANEL_MIN_SIDE_BY_SIDE);
  const [repositories, setRepositories] = React.useState<Repository[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checkoutBranch, setCheckoutBranch] = React.useState<string | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const load = React.useCallback(async () => {
    try {
      setRepositories(await api.get<Repository[]>(`/api/companies/${companyId}/repositories`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this repository.");
    }
  }, [companyId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  useLiveRefetch("repository", load);

  // The link carries whatever casing the model wrote; slugs are lowercase, so
  // matching loosely here is the difference between the panel and a dead end.
  const wanted = target.repositorySlug.toLowerCase();
  const repo = repositories?.find((row) => row.slug.toLowerCase() === wanted) ?? null;
  const base = repo ? `/api/companies/${companyId}/repositories/${repo.slug}` : "";

  // Accepting work merges it into whatever branch the App's checkout is on,
  // and the buttons name it. A failure here is not worth surfacing — the pane
  // falls back to "the current branch".
  React.useEffect(() => {
    if (!base) return;
    let cancelled = false;
    api
      .get<RepositoryStatus>(`${base}/workspace/status`)
      .then((status) => {
        if (!cancelled) setCheckoutBranch(status.branch ?? null);
      })
      .catch(() => {
        if (!cancelled) setCheckoutBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  // Nothing in this panel needs a list refresh — the Repository page reloads
  // itself off the resource-change socket when it is open elsewhere.
  const onChanged = React.useCallback(async () => {}, []);

  const fullPageHref = repositoryWorkHref(companySlug, {
    repositorySlug: repo?.slug ?? target.repositorySlug,
    sessionId: target.sessionId,
  });

  // The rail is offered on a narrow window too. Ignoring `collapsed` there
  // would turn a wound-down panel into a full-screen takeover the moment
  // someone resized, and would leave no way back other than closing it. It
  // docks at every width rather than floating: 44 px costs the conversation
  // almost nothing, and a floating rail sits on top of the composer's Send
  // button and swallows the clicks that land on its right edge.
  if (collapsed) {
    return (
      <aside
        className="relative flex h-full w-11 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
        aria-label="Repository work"
      >
        <button
          onClick={() => onCollapsedChange(false)}
          className="flex h-full w-full flex-col items-center gap-2 py-3 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          title="Show repository work"
        >
          <FolderGit2 size={16} />
          <span className="rotate-180 text-[10px] font-semibold uppercase tracking-wider [writing-mode:vertical-rl]">
            Work
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={
        wide
          ? "relative flex h-full min-h-0 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" +
            (resizing ? "" : " transition-[width] duration-200")
          : // Too narrow to sit beside the thread: take the screen instead of
            // squeezing both into a pair of slivers.
            "absolute inset-0 z-30 flex min-h-0 flex-col bg-white dark:bg-slate-900"
      }
      style={wide ? { width } : undefined}
      aria-label="Repository work"
    >
      {wide && (
        <SidePanelResizeHandle
          label="Resize repository work panel"
          onPointerDown={startResize}
          onKeyDown={onResizeKeyDown}
          active={resizing}
        />
      )}

      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <FolderGit2 size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
            {repo?.name ?? target.repositorySlug}
          </div>
          <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            AI work · reviewed here, without leaving the thread
          </div>
        </div>
        <Link
          to={fullPageHref}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Open the full page"
          aria-label="Open the full page"
        >
          <Maximize2 size={14} />
        </Link>
        {wide && (
          <button
            onClick={() => onCollapsedChange(true)}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Collapse"
            aria-label="Collapse repository work"
          >
            <SidePanelCollapseIcon />
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Hide repository work"
          aria-label="Hide repository work"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* A failure only takes the panel when there is nothing else to show.
          The repository list is re-read on every repository change in the
          company — including the ones this session causes — and a transient
          failure must not replace the diff someone is reading with a retry
          box. The next tick reloads it. */}
        {error && repositories === null ? (
          <div className="p-3">
            <InlineRetry message={error} onRetry={load} compact />
          </div>
        ) : repositories === null ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={18} />
          </div>
        ) : !repo ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <FolderGit2 size={28} className="text-slate-300 dark:text-slate-600" />
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              This repository is not available to you
            </h3>
            <p className="max-w-xs text-xs text-slate-500 dark:text-slate-400">
              {target.repositorySlug} has been removed, renamed, or was never one you can open. Ask
              an owner or admin if you should have access to it.
            </p>
          </div>
        ) : (
          <SessionPane
            key={`${currentUserId}:${target.sessionId}`}
            layout="panel"
            companyId={companyId}
            currentUserId={currentUserId}
            repoId={repo.id}
            base={base}
            sessionId={target.sessionId}
            repoName={repo.name}
            allowPush={repo.origin === "remote"}
            allowPullRequest={repo.origin === "remote" && isGithubRemote(repo.gitUrl)}
            canReachRemote={companyRole === "owner" || companyRole === "admin"}
            checkoutBranch={checkoutBranch}
            dialog={dialog}
            toast={toast}
            onChanged={onChanged}
            onGone={onClose}
          />
        )}
      </div>
    </aside>
  );
}
