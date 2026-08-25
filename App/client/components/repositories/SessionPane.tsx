import React from "react";
import {
  Activity,
  AlertCircle,
  ArrowUp,
  Check,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Lock,
  MessageSquareText,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { useDialog } from "../ui/Dialog";
import { useLiveRefetch } from "../CompanySocket";
import { ChatMarkdown } from "../ChatMarkdown";
import { formatRelative } from "../decisions/relative";
import { DiffStats, DiffView } from "./DiffView";
import { InlineRetry, TONE_CLASS } from "./sessionChrome";
import { usePersistedDraft } from "./persistedDraft";
import {
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TONE,
  hasReviewableWork,
  sessionActions,
  sessionTitle,
} from "./sessionState";
import {
  api,
  RepositoryCommit,
  RepositoryWorkSession,
  RepositoryWorkSessionDetail,
  RepositoryWorkSessionDiff,
  RepositoryWorkSessionTurn,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";

/**
 * One work session, everywhere it is shown.
 *
 * The Repository section gives this the page's main column; chat docks it in a
 * panel beside the conversation that started the work, so a Member can read
 * the diff without losing the thread they were in. Both need the same
 * transcript, the same diff, and — the part that must not be duplicated — the
 * same rules about which of accept / send / open a pull request / throw away
 * is even offered.
 *
 * `layout` is the only difference between them. The page can spread Activity
 * and Changes across a wide monitor; a panel is a narrow column whatever the
 * monitor is doing, so it always tabs between the two and scrolls inside
 * itself rather than inside the page.
 */
export type SessionPaneLayout = "page" | "panel";

/** A running turn can take minutes, so the open session is polled as well. */
const RUNNING_POLL_MS = 4000;

type WorkspaceView = "activity" | "changes";

/**
 * Activity and Changes are the same card in both layouts; the page can show
 * both at once on a wide monitor, a docked panel shows whichever tab is
 * selected and fills the height it was given.
 */
function paneClassName(docked: boolean, visible: boolean): string {
  if (docked) {
    return (
      (visible ? "flex" : "hidden") +
      " min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-slate-900"
    );
  }
  return (
    (visible ? "flex" : "hidden") +
    " min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 min-[1800px]:flex"
  );
}

export function SessionPane({
  companyId,
  currentUserId,
  repoId,
  base,
  sessionId,
  repoName,
  allowPush,
  allowPullRequest,
  canReachRemote,
  checkoutBranch,
  dialog,
  onChanged,
  onGone,
  layout = "page",
}: {
  companyId: string;
  currentUserId: string;
  repoId: string | null;
  base: string;
  sessionId: string;
  repoName: string;
  allowPush: boolean;
  allowPullRequest: boolean;
  canReachRemote: boolean;
  checkoutBranch: string | null;
  dialog: ReturnType<typeof useDialog>;
  onChanged: () => Promise<void>;
  onGone: () => void;
  layout?: SessionPaneLayout;
}) {
  /**
   * A docked panel is a narrow column however wide the monitor is, so it never
   * takes the page's two-up split, and it scrolls inside itself rather than
   * letting the whole page scroll past a header it needs to keep.
   */
  const docked = layout === "panel";
  const [detail, setDetail] = React.useState<RepositoryWorkSessionDetail | null>(null);
  const [diff, setDiff] = React.useState<RepositoryWorkSessionDiff | null | undefined>(undefined);
  const [view, setView] = React.useState<WorkspaceView>("activity");
  const [instruction, setInstruction] = usePersistedDraft(
    `repository-ai-revision-draft:${currentUserId}:${sessionId}`,
  );
  const [sending, setSending] = React.useState(false);
  const [acting, setActing] = React.useState(false);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [diffError, setDiffError] = React.useState<string | null>(null);
  /**
   * The last action's failure, kept on the page until it is dismissed. A
   * message saying a pull request could not be opened is an instruction, not
   * a notice — it has to stay put while someone acts on it.
   */
  const [failure, setFailure] = React.useState<string | null>(null);
  const transcriptEnd = React.useRef<HTMLDivElement | null>(null);
  const detailRequest = React.useRef(0);
  const diffRequest = React.useRef(0);
  const previousStatus = React.useRef<RepositoryWorkSession["status"] | null>(null);

  const reload = React.useCallback(async () => {
    const request = ++detailRequest.current;
    try {
      const next = await api.get<RepositoryWorkSessionDetail>(`${base}/sessions/${sessionId}`);
      if (request !== detailRequest.current) return;
      setDetail(next);
      setDetailError(null);
    } catch (err) {
      if (request !== detailRequest.current) return;
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  }, [base, sessionId]);

  // Opening a *different* session blanks the pane; re-reading the same one
  // must not, or a background refresh replaces what someone is reading with a
  // spinner.
  React.useEffect(() => {
    detailRequest.current += 1;
    diffRequest.current += 1;
    setDetail(null);
    setDiff(undefined);
    setDetailError(null);
    setDiffError(null);
  }, [sessionId]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // The list already re-reads on the resource-change socket; without this the
  // open session kept whatever state it was loaded with, so its buttons went
  // on offering actions the server had already moved past.
  useLiveRefetch("repository", reload, repoId);

  const session = detail?.session ?? null;
  const running = session?.status === "running";
  const headCommit = session?.headCommit ?? null;

  // The resource-change socket already announces the outcome, but a turn that
  // dies without writing anything would leave the spinner up forever, so a
  // slow poll runs alongside it — and only while something is actually running.
  React.useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => {
      reload();
    }, RUNNING_POLL_MS);
    return () => window.clearInterval(handle);
  }, [running, reload]);

  const loadDiff = React.useCallback(async () => {
    const request = ++diffRequest.current;
    try {
      const next = await api.get<RepositoryWorkSessionDiff>(`${base}/sessions/${sessionId}/diff`);
      if (request !== diffRequest.current) return;
      setDiff(next);
      setDiffError(null);
    } catch (err) {
      if (request !== diffRequest.current) return;
      setDiffError(err instanceof Error ? err.message : String(err));
      setDiff(undefined);
    }
  }, [base, sessionId]);

  // Re-read the diff whenever the branch moves, so a revision's changes appear
  // without anyone having to collapse and reopen the panel.
  React.useEffect(() => {
    if (!headCommit) return;
    setDiff(null);
    setDiffError(null);
    void loadDiff();
  }, [running, headCommit, loadDiff]);

  // Only when the transcript actually grows. Scrolling on the first render
  // would yank someone who just opened an old session to the bottom of it.
  const turnCount = detail?.turns.length ?? 0;
  const lastTurnCount = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (lastTurnCount.current !== null && turnCount > lastTurnCount.current) {
      transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    lastTurnCount.current = turnCount;
  }, [turnCount]);

  // A session opened after it finished lands directly in Changes. If a live
  // turn finishes while someone watches, take them to the result once; after
  // that their chosen view is left alone.
  React.useEffect(() => {
    if (!session) return;
    const previous = previousStatus.current;
    if (previous === null) {
      setView(hasReviewableWork(session) ? "changes" : "activity");
    } else if (previous === "running" && hasReviewableWork(session)) {
      setView("changes");
    }
    previousStatus.current = session.status;
  }, [session]);

  if (!session) {
    return detailError ? (
      <InlineRetry
        message={detailError}
        onRetry={reload}
        onBack={onGone}
        backLabel={docked ? "Close" : undefined}
      />
    ) : (
      <SessionWorkspaceSkeleton />
    );
  }

  const actions = sessionActions(session, {
    remote: allowPush,
    github: allowPullRequest,
    admin: canReachRemote,
  });
  const tone = SESSION_STATUS_TONE[session.status];
  const employeeName = session.employee?.name ?? "Removed employee";
  const target = checkoutBranch ?? "the current branch";
  const avatarSrc = session.employee
    ? employeeAvatarUrl(companyId, session.employee.id, session.employee.avatarKey)
    : null;

  /** Every action clears the last failure first — it belongs to the old attempt. */
  async function run(work: () => Promise<void>) {
    setFailure(null);
    setActing(true);
    try {
      await work();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function send() {
    const text = instruction.trim();
    if (!text) {
      setFailure("Say what should change.");
      return;
    }
    setSending(true);
    setFailure(null);
    try {
      const next = await api.post<RepositoryWorkSessionDetail>(
        `${base}/sessions/${sessionId}/revise`,
        { instruction: text },
      );
      setInstruction("");
      setDetail(next);
      await onChanged();
    } catch (err) {
      // The banner keeps this on screen: this is the one action whose failure
      // message people need while they retype the instruction.
      setFailure(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function publish(push: boolean) {
    const ok = await dialog.confirm({
      title: push
        ? "Accept these changes and send them on?"
        : `Accept these changes into ${target}?`,
      message: push
        ? `The work goes into ${target} and is sent to ${repoName}'s remote copy straight away. Sending cannot be undone.`
        : `The work goes into ${target}, here in Genosyn. Nothing is sent anywhere else until you choose to.`,
      confirmLabel: push ? "Accept and send" : "Accept changes",
    });
    if (!ok) return;
    await run(async () => {
      await api.post(`${base}/sessions/${sessionId}/publish`, { push });
      await reload();
      await onChanged();
    });
  }

  async function openPullRequest(isUpdate: boolean) {
    const ok = await dialog.confirm({
      title: isUpdate ? "Send the new commits to the pull request?" : "Open a pull request?",
      message: isUpdate
        ? `${session?.branch} is pushed again so the open pull request picks up everything since it was opened.`
        : `${session?.branch} is pushed to ${repoName}'s remote copy and a pull request is opened for it. Your team reviews and merges it there.`,
      confirmLabel: isUpdate ? "Push the update" : "Open pull request",
    });
    if (!ok) return;
    await run(async () => {
      await api.post(`${base}/sessions/${sessionId}/pull-request`, {});
      await reload();
      await onChanged();
    });
  }

  async function discard() {
    const ok = await dialog.confirm({
      title: "Throw this work away?",
      message: session?.pullRequestUrl
        ? `The local session branch is removed, but the existing pull request and its remote branch are not closed or deleted. The session stays in this list for reference.`
        : `Nothing ${employeeName} changed is merged into ${repoName}. The local session branch is removed, and the session stays in this list for reference.`,
      confirmLabel: "Throw it away",
      variant: "danger",
    });
    if (!ok) return;
    await run(async () => {
      await api.post(`${base}/sessions/${sessionId}/discard`);
      await reload();
      await onChanged();
    });
  }

  async function saveTitle() {
    const next = (renaming ?? "").trim();
    setRenaming(null);
    if (!next || next === session?.title) return;
    setFailure(null);
    try {
      await api.patch(`${base}/sessions/${sessionId}`, { title: next });
      await reload();
      await onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    }
  }

  const hasActions =
    actions.accept || actions.acceptAndSend || actions.pullRequest || actions.discard;
  const changesReady = !!session.headCommit;

  return (
    <section className={docked ? "flex h-full min-h-0 min-w-0 flex-col" : "flex min-w-0 flex-col"}>
      <header
        className={
          docked
            ? "shrink-0 overflow-hidden border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            : "sticky top-0 z-20 overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/95"
        }
      >
        <div className="px-4 pb-3 pt-3.5 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            {renaming === null ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <h2 className="min-w-0 truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                  {sessionTitle(session)}
                </h2>
                <button
                  type="button"
                  onClick={() => setRenaming(sessionTitle(session))}
                  title="Rename this session"
                  className="shrink-0 rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                >
                  <Pencil size={12} />
                </button>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  value={renaming}
                  autoFocus
                  onChange={(event) => setRenaming(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveTitle();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => void saveTitle()}
                  aria-label="Save session name"
                  className="rounded p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(null)}
                  aria-label="Cancel rename"
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <span
              aria-live="polite"
              className={
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold " +
                TONE_CLASS[tone]
              }
            >
              {running && <Spinner size={10} />}
              {SESSION_STATUS_LABEL[session.status]}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={employeeName} kind="ai" size="xs" src={avatarSrc} />
              {employeeName}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock3 size={11} /> {formatRelative(session.createdAt)}
            </span>
            {session.branch && (
              <span
                className="inline-flex max-w-full items-center gap-1 truncate font-mono"
                title={`Committed on ${session.branch}`}
              >
                <GitBranch size={11} className="shrink-0" /> {session.branch}
              </span>
            )}
            {session.pullRequestUrl && (
              <a
                href={session.pullRequestUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
              >
                <GitPullRequest size={11} />
                {session.pullRequestNumber
                  ? `Pull request #${session.pullRequestNumber}`
                  : "Pull request"}
                <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>

        <div
          className={
            "flex border-t border-slate-100 px-2 dark:border-slate-800" +
            (docked ? "" : " min-[1800px]:hidden")
          }
        >
          <WorkspaceTab
            active={view === "activity"}
            icon={<Activity size={14} />}
            label="Activity"
            count={detail?.turns.length ?? 0}
            onClick={() => setView("activity")}
          />
          <WorkspaceTab
            active={view === "changes"}
            icon={<FileDiff size={14} />}
            label="Changes"
            count={session.filesChanged}
            attention={session.status === "ready" || session.status === "proposed"}
            onClick={() => setView("changes")}
          />
        </div>
      </header>

      {detailError && (
        <div className={docked ? "mx-3 mt-3 shrink-0" : "mt-3"}>
          <InlineRetry message={detailError} onRetry={reload} compact />
        </div>
      )}

      {failure && (
        <div
          className={
            (docked ? "mx-3 shrink-0 " : "") +
            "mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/5 dark:text-rose-300"
          }
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{failure}</span>
          <button
            type="button"
            onClick={() => setFailure(null)}
            className="shrink-0 rounded p-0.5 text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/10"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div
        className={
          docked
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : "mt-4 min-w-0 gap-4 min-[1800px]:grid min-[1800px]:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]"
        }
      >
        <section className={paneClassName(docked, view === "activity")}>
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <MessageSquareText size={15} className="text-slate-400" /> Activity
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                Every brief and result in this session
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {detail?.turns.length ?? 0}
            </span>
          </div>

          <div
            className={
              "flex-1 space-y-6 px-4 py-5 sm:px-5 " +
              (docked
                ? "min-h-0 overflow-y-auto"
                : "min-h-[20rem] min-[1800px]:max-h-[calc(100vh-21rem)] min-[1800px]:overflow-y-auto")
            }
          >
            {(detail?.turns ?? []).map((turn) => (
              <TurnBlock
                key={turn.id}
                turn={turn}
                employeeName={employeeName}
                avatarSrc={avatarSrc}
              />
            ))}
            <div ref={transcriptEnd} />
          </div>

          <div className="border-t border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-950/20">
            {actions.revise ? (
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-indigo-700 dark:focus-within:ring-indigo-900/30">
                <textarea
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
                  }}
                  rows={3}
                  maxLength={20000}
                  placeholder={`Ask ${employeeName} for another pass…`}
                  className="w-full resize-y border-0 bg-transparent px-3 py-2.5 text-sm leading-6 text-slate-700 placeholder:text-slate-400 focus:outline-none dark:text-slate-200 dark:placeholder:text-slate-500"
                />
                <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-2.5 py-2 dark:border-slate-800">
                  <span className="min-w-0 truncate text-[10px] text-slate-400 dark:text-slate-500">
                    Same employee, branch, and context ·{" "}
                    {instruction ? "draft saved" : "⌘↵ to send"}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => void send()}
                    disabled={sending || !instruction.trim()}
                  >
                    {sending ? <Spinner size={13} /> : <ArrowUp size={13} />}
                    {sending ? "Sending…" : "Send"}
                  </Button>
                </div>
              </div>
            ) : (
              <SessionClosedNotice session={session} employeeName={employeeName} />
            )}
          </div>
        </section>

        <section className={paneClassName(docked, view === "changes")}>
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <FileDiff size={15} className="text-slate-400" /> Changes
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                  Review the complete branch before deciding
                </p>
              </div>
              {session.filesChanged > 0 && (
                <DiffStats
                  filesChanged={session.filesChanged}
                  insertions={session.insertions}
                  deletions={session.deletions}
                />
              )}
            </div>

            {hasActions && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                {actions.pullRequest && (
                  <Button
                    size="sm"
                    onClick={() => void openPullRequest(actions.pullRequestIsUpdate)}
                    disabled={acting}
                  >
                    {acting ? <Spinner size={13} /> : <GitPullRequest size={13} />}
                    {actions.pullRequestIsUpdate ? "Update pull request" : "Open pull request"}
                  </Button>
                )}
                {actions.accept && (
                  <Button
                    size="sm"
                    variant={actions.pullRequest ? "secondary" : "primary"}
                    onClick={() => void publish(false)}
                    disabled={acting}
                  >
                    <GitMerge size={13} />
                    {checkoutBranch ? `Accept into ${checkoutBranch}` : "Accept changes"}
                  </Button>
                )}
                {actions.acceptAndSend && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void publish(true)}
                    disabled={acting}
                  >
                    <Upload size={13} /> Accept and send
                  </Button>
                )}
                {actions.discard && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                    onClick={() => void discard()}
                    disabled={acting}
                  >
                    <Trash2 size={13} /> Throw away
                  </Button>
                )}
              </div>
            )}

            {actions.accept && !allowPush && (
              <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                This repository lives only in Genosyn — there is nowhere else to send it.
              </p>
            )}
            {actions.remoteNeedsAdmin && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                <Lock size={11} className="shrink-0" />
                Only an owner or admin can push this to {repoName} or open a pull request for it.
              </p>
            )}
          </div>

          <div
            className={
              "flex-1 overflow-y-auto bg-slate-50/40 p-3 dark:bg-slate-950/20 sm:p-4 " +
              (docked ? "min-h-0" : "min-h-[20rem] min-[1800px]:max-h-[calc(100vh-21rem)]")
            }
          >
            {session.status === "running" && !session.headCommit ? (
              <ChangeWaiting employeeName={employeeName} />
            ) : !changesReady ? (
              <NoChangesState session={session} />
            ) : diffError ? (
              <InlineRetry message={diffError} onRetry={loadDiff} />
            ) : diff === null || diff === undefined ? (
              <DiffSkeleton />
            ) : (
              <div className="space-y-3">
                {session.status === "running" && <RevisionWaiting employeeName={employeeName} />}
                {diff.commits.length > 0 && <CommitCheckpoints commits={diff.commits} />}
                <DiffView
                  patch={diff.patch}
                  truncated={diff.truncated}
                  filesChanged={session.filesChanged}
                  emptyMessage="This branch has no file changes."
                />
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function WorkspaceTab({
  active,
  icon,
  label,
  count,
  attention,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  attention?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "relative inline-flex items-center gap-2 px-3 py-2.5 text-xs font-medium transition-colors " +
        (active
          ? "text-indigo-700 dark:text-indigo-300"
          : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
      }
    >
      {icon}
      {label}
      <span
        className={
          "rounded-full px-1.5 py-0.5 font-mono text-[9px] tabular-nums " +
          (active
            ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500")
        }
      >
        {count}
      </span>
      {attention && !active && (
        <span className="absolute right-1.5 top-2 h-1.5 w-1.5 rounded-full bg-amber-500" />
      )}
      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-500" />}
    </button>
  );
}

function SessionClosedNotice({
  session,
  employeeName,
}: {
  session: RepositoryWorkSession;
  employeeName: string;
}) {
  const message =
    session.status === "running"
      ? `${employeeName} is working. Another instruction can be sent as soon as this turn finishes.`
      : session.status === "published"
        ? "This work has been accepted. Start a new session for another outcome."
        : "This session was thrown away. Start a new session for another outcome.";
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-slate-200 bg-white px-3 py-2.5 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
      {session.status === "running" ? (
        <span className="mt-0.5 shrink-0">
          <Spinner size={13} />
        </span>
      ) : (
        <CircleCheck size={13} className="mt-0.5 shrink-0" />
      )}
      {message}
    </div>
  );
}

function ChangeWaiting({ employeeName }: { employeeName: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white px-6 text-center dark:border-slate-700 dark:bg-slate-900">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
        <Spinner size={18} />
      </span>
      <h4 className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {employeeName} is building the first checkpoint
      </h4>
      <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
        Committed files and the complete diff will appear here automatically when this turn ends.
      </p>
    </div>
  );
}

function RevisionWaiting({ employeeName }: { employeeName: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50/60 px-3 py-2.5 text-xs leading-5 text-indigo-700 dark:border-indigo-500/25 dark:bg-indigo-500/5 dark:text-indigo-300">
      <span className="mt-0.5 shrink-0">
        <Spinner size={13} />
      </span>
      <span>
        {employeeName} is working on another pass. These are the committed changes so far; this view
        refreshes when the turn ends.
      </span>
    </div>
  );
}

function NoChangesState({ session }: { session: RepositoryWorkSession }) {
  const failed = session.status === "failed";
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white px-6 text-center dark:border-slate-700 dark:bg-slate-900">
      <span
        className={
          "flex h-11 w-11 items-center justify-center rounded-xl " +
          (failed
            ? "bg-rose-50 text-rose-500 dark:bg-rose-500/10 dark:text-rose-300"
            : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500")
        }
      >
        {failed ? <AlertCircle size={18} /> : <FileDiff size={18} />}
      </span>
      <h4 className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {failed ? "No reviewable changes yet" : "No committed changes"}
      </h4>
      <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
        {failed
          ? "Read the error in Activity, then ask the employee to retry with any extra context it needs."
          : "Read the employee's result in Activity. If work was expected, ask for another pass in the same session."}
      </p>
    </div>
  );
}

function CommitCheckpoints({ commits }: { commits: RepositoryCommit[] }) {
  const visible = commits.slice(0, 6);
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
          <CircleCheck size={13} className="text-emerald-500" /> Commit checkpoints
        </h4>
        <span className="font-mono text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
          {commits.length}
        </span>
      </div>
      <ol className="divide-y divide-slate-100 dark:divide-slate-800">
        {visible.map((commit) => (
          <li key={commit.sha} className="flex min-w-0 items-start gap-2.5 px-3 py-2">
            <code className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {commit.shortSha}
            </code>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                {commit.subject || "Untitled commit"}
              </span>
              <span className="mt-0.5 block text-[10px] text-slate-400 dark:text-slate-500">
                {commit.authorName} · {formatRelative(commit.authoredAt)}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {commits.length > visible.length && (
        <div className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
          +{commits.length - visible.length} earlier checkpoints
        </div>
      )}
    </section>
  );
}

function SessionWorkspaceSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-24 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
      <div className="grid gap-4 min-[1800px]:grid-cols-2">
        <div className="h-96 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        <div className="hidden h-96 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 min-[1800px]:block" />
      </div>
    </div>
  );
}

function DiffSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-11 rounded-xl bg-slate-200/70 dark:bg-slate-800" />
      <div className="h-11 rounded-xl bg-slate-200/60 dark:bg-slate-800/80" />
      <div className="h-11 rounded-xl bg-slate-200/50 dark:bg-slate-800/60" />
    </div>
  );
}

/** One instruction and what came back — the unit the transcript is made of. */
function TurnBlock({
  turn,
  employeeName,
  avatarSrc,
}: {
  turn: RepositoryWorkSessionTurn;
  employeeName: string;
  avatarSrc: string | null;
}) {
  return (
    <article className="flex flex-col gap-3">
      {/* The instruction reads as a quotation of what was asked, not as a chat
        bubble: it is the heading for the work below it, and a right-aligned
        bubble put the two halves of one exchange on opposite sides of the
        page. */}
      <div className="border-l-2 border-indigo-300 pl-3 dark:border-indigo-500/50">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500/80 dark:text-indigo-300/80">
          Brief {turn.ordinal} · {formatRelative(turn.createdAt)}
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 dark:text-slate-200">
          {turn.instruction}
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <Avatar
          name={employeeName}
          kind="ai"
          size="sm"
          src={avatarSrc}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          {turn.status === "running" ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              <Spinner size={14} />
              <span>{employeeName} is working. This updates itself when the turn ends.</span>
            </div>
          ) : (
            <>
              {turn.error && (
                <div className="mb-2 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/5 dark:text-rose-300">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span className="break-words">{turn.error}</span>
                </div>
              )}
              {turn.reply.trim() ? (
                <div className="text-sm leading-6 text-slate-700 dark:text-slate-200">
                  <ChatMarkdown content={turn.reply} />
                </div>
              ) : (
                !turn.error && (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {employeeName} finished without saying anything.
                  </p>
                )
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
                {turn.headCommit && (
                  <span className="inline-flex items-center gap-1 font-mono">
                    <CircleCheck size={11} className="text-emerald-500" />
                    checkpoint {turn.headCommit.slice(0, 7)}
                  </span>
                )}
                {turn.filesChanged > 0 ? (
                  <DiffStats
                    filesChanged={turn.filesChanged}
                    insertions={turn.insertions}
                    deletions={turn.deletions}
                    className="text-[11px]"
                  />
                ) : (
                  turn.status === "ok" && <span>Committed nothing on this turn</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
