import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  CircleCheck,
  Inbox,
  Plus,
  Paperclip,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button, buttonClassName } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { useLiveRefetch } from "../components/CompanySocket";
import { formatRelative } from "../components/decisions/relative";
import { SessionPane } from "../components/repositories/SessionPane";
import { DOT_CLASS, InlineRetry } from "../components/repositories/sessionChrome";
import { usePersistedDraft } from "../components/repositories/persistedDraft";
import {
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TONE,
  SESSION_INBOX_GROUP_LABEL,
  SESSION_INBOX_GROUP_ORDER,
  groupSessions,
  isArchived,
  matchesSessionSearch,
  sessionSubtitle,
  sessionSearchText,
  sessionTitle,
  sortSessions,
} from "../components/repositories/sessionState";
import {
  api,
  RepositoryStatus,
  RepositoryWorkSession,
  RepositoryWorkSessionCandidatesResponse,
  RepositoryWorkSessionsResponse,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { useChatAttachments } from "@/lib/stagedChatAttachments";
import { useComposerFileDrop } from "@/lib/fileDrop";
import { ChatAttachments } from "@/components/chat/ChatAttachments";
import { WorkSessionModelPicker } from "@/components/repositories/WorkSessionModelPicker";
import {
  MODEL_EFFORT_LABELS,
  resolveWorkSessionModelId,
  type WorkSessionModelOverride,
} from "@/lib/workSessionModel";
import type { ChatAttachment, ModelEffort } from "@/lib/api";
import { useRepositoriesContext } from "./RepositoriesLayout";

/**
 * AI work — sessions with an AI Employee in this repository.
 *
 * The shape is deliberately the one people already know from an agentic coding
 * tool: an inbox of sessions on the left and a focused Activity/Changes
 * workbench on the right. A session is not a single request. You ask, review
 * the result, request another pass, and the same employee picks up in the same
 * working copy on the same branch.
 *
 * Three things shape the layout, and all three came from watching the old one
 * fail:
 *
 *   1. **Attention is visible.** Sessions are grouped by what is active, what
 *      needs a decision, and what is complete; search works across the brief,
 *      employee, branch, and status.
 *   2. **Activity and Changes have room.** The running narrative and the
 *      complete branch review are focused tabs on ordinary screens and sit
 *      together on wide ones. Large diffs still lead with a compact summary.
 *   3. **A button that will fail is not offered.** Pushing and opening a pull
 *      request are owner/admin-only server-side; the page knows the viewer's
 *      role and says so instead of letting them find out via a 403.
 *
 * What has not changed is who decides. The employee commits to its own branch
 * and stops there; merging it, sending it to the remote, or handing it to the
 * team as a pull request are all Member actions, and the credentials for the
 * last two never leave the server.
 */

const STARTERS: Record<"code" | "documents", Array<{ label: string; prompt: string }>> = {
  code: [
    {
      label: "Fix a bug",
      prompt:
        "Investigate and fix this bug: [describe what is going wrong]. Add a regression test, commit the result, and state which checks a Member should run.",
    },
    {
      label: "Ship a feature",
      prompt:
        "Implement this feature: [describe the outcome]. Follow the repository's existing patterns, cover the behavior with tests, commit the result, and state which checks a Member should run.",
    },
    {
      label: "Improve quality",
      prompt:
        "Review [area or file] for reliability and maintainability issues. Fix the highest-impact problems, commit the changes, and state which checks a Member should run.",
    },
  ],
  documents: [
    {
      label: "Rewrite a section",
      prompt:
        "Rewrite [file and section] for [audience and goal]. Preserve the useful facts, make the structure easier to scan, and commit the result.",
    },
    {
      label: "Audit consistency",
      prompt:
        "Review these documents for contradictions, stale guidance, and inconsistent terminology. Fix what you find and commit the result.",
    },
    {
      label: "Add a guide",
      prompt:
        "Create a practical guide for [topic and audience]. Match the repository's existing voice and structure, link related material, and commit it.",
    },
  ],
};

export default function RepositoryAi() {
  const { company, currentUserId, repo } = useRepositoriesContext();
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();

  const base = repo ? `/api/companies/${company.id}/repositories/${repo.slug}` : "";
  const aiBase = repo ? `/c/${company.slug}/repositories/${repo.slug}/ai` : "";
  const repoId = repo?.id ?? null;
  const isRemote = repo?.origin === "remote";
  // Whether a pull request can be opened here is the server's answer, not a
  // hostname the browser can read off the clone URL: it depends on which forge
  // Connections cover this host, and their base URLs never leave the server.
  const canOpenPullRequest = !!repo?.forge;
  // Both routes that reach the remote — pushing and opening a pull request —
  // are gated on this server-side. Offering either to a Member who will be
  // refused turns a permission boundary into a broken button.
  const canReachRemote = company.role === "owner" || company.role === "admin";

  // Stable, because SessionPane lists it in the deps of its `reload` callback.
  // An inline arrow here gave `reload` a new identity on every render of this
  // component, and the effect that calls it resets the pane to a spinner — so
  // every socket tick blanked the open session and refetched it.
  const goToSessionList = React.useCallback(() => navigate(aiBase), [navigate, aiBase]);

  const [sessions, setSessions] = React.useState<RepositoryWorkSession[] | null>(null);
  /**
   * The filed-away sessions, read separately rather than filtered out of one
   * list. The point of archiving is that a repository with two hundred
   * finished sessions stops shipping all two hundred of them to draw a
   * sidebar; a client-side filter would ship them anyway.
   */
  const [archived, setArchived] = React.useState<RepositoryWorkSession[] | null>(null);
  const [candidates, setCandidates] = React.useState<
    RepositoryWorkSessionCandidatesResponse["employees"] | null
  >(null);
  const [sessionsError, setSessionsError] = React.useState<string | null>(null);
  const [candidatesError, setCandidatesError] = React.useState<string | null>(null);
  /** Where accepted work lands. Null until the first status read comes back. */
  const [checkoutBranch, setCheckoutBranch] = React.useState<string | null>(null);
  const listRequest = React.useRef(0);

  const reloadList = React.useCallback(async () => {
    if (!base) return;
    const request = ++listRequest.current;
    const [sessionRows, archivedRows, candidateRows, status] = await Promise.allSettled([
      api.get<RepositoryWorkSessionsResponse>(`${base}/sessions`),
      api.get<RepositoryWorkSessionsResponse>(`${base}/sessions?archived=1`),
      api.get<RepositoryWorkSessionCandidatesResponse>(`${base}/session-candidates`),
      // Accepting work merges it into whatever branch this checkout is on,
      // and the page used to ask people to approve that without ever naming
      // it. One extra read buys the sentence its missing fact.
      api.get<RepositoryStatus>(`${base}/workspace/status`),
    ]);
    if (request !== listRequest.current) return;

    if (sessionRows.status === "fulfilled") {
      setSessions(sortSessions(sessionRows.value.sessions));
      setSessionsError(null);
    } else {
      setSessionsError(
        sessionRows.reason instanceof Error
          ? sessionRows.reason.message
          : "Could not load work sessions.",
      );
    }

    // The archive is secondary: it is read for a count and for the drawer
    // behind a toggle, and a failure to load it must not take the inbox with
    // it. Left as null, the toggle simply says nothing is there yet.
    if (archivedRows.status === "fulfilled") setArchived(archivedRows.value.sessions);

    // Candidate and history failures are deliberately independent. A broken
    // grant read should not erase a useful session history, and vice versa.
    if (candidateRows.status === "fulfilled") {
      setCandidates(candidateRows.value.employees);
      setCandidatesError(null);
    } else {
      setCandidatesError(
        candidateRows.reason instanceof Error
          ? candidateRows.reason.message
          : "Could not load AI employees.",
      );
    }

    if (status.status === "fulfilled") setCheckoutBranch(status.value.branch ?? null);
  }, [base]);

  React.useEffect(() => {
    listRequest.current += 1;
    setSessions(null);
    setArchived(null);
    setCandidates(null);
    setSessionsError(null);
    setCandidatesError(null);
    setCheckoutBranch(null);
    void reloadList();
  }, [reloadList]);

  const setSessionArchived = React.useCallback(
    async (session: RepositoryWorkSession, next: boolean) => {
      try {
        await api.post(`${base}/sessions/${session.id}/archive`, { archived: next });
        await reloadList();
      } catch (err) {
        void dialog.error(err, {
          title: next ? "Couldn’t archive the work session" : "Couldn’t restore the work session",
        });
      }
    },
    [base, reloadList, dialog],
  );

  useLiveRefetch("repository", reloadList, repoId);
  // AI Model changes are scoped to their employee, so a repository-only
  // subscription would leave choices stale when another tab edits a model.
  useLiveRefetch("employee", reloadList);

  if (!repo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const rows = sessions ?? [];
  const anyRunning = rows.some((row) => row.status === "running");
  const attentionCount = rows.filter((row) =>
    ["ready", "empty", "proposed", "failed"].includes(row.status),
  ).length;

  return (
    <div className="pb-8">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20">
            <Inbox size={17} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                AI work
              </h1>
              {attentionCount > 0 && (
                <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                  {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
                </span>
              )}
            </div>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">
              Delegate changes, follow the work, and decide what reaches {repo.name}.
            </p>
          </div>
        </div>
        {sessionId && (
          <Link
            to={aiBase}
            className={buttonClassName({ variant: "secondary", size: "sm", className: "shrink-0" })}
          >
            <Plus size={14} /> New session
          </Link>
        )}
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
        <SessionInbox
          companyId={company.id}
          sessions={sessions}
          archived={archived}
          error={sessionsError}
          activeId={sessionId ?? null}
          aiBase={aiBase}
          onRetry={reloadList}
          onSelect={(id) => navigate(id ? `${aiBase}/${id}` : aiBase)}
          onArchivedChange={setSessionArchived}
        />

        <div className="min-w-0 flex-1">
          {sessionId ? (
            <SessionPane
              key={`${currentUserId}:${sessionId}`}
              companyId={company.id}
              currentUserId={currentUserId}
              repoId={repoId}
              base={base}
              sessionId={sessionId}
              repoName={repo.name}
              allowPush={isRemote}
              allowPullRequest={isRemote && canOpenPullRequest}
              canReachRemote={canReachRemote}
              checkoutBranch={checkoutBranch}
              dialog={dialog}
              onChanged={reloadList}
              onGone={goToSessionList}
            />
          ) : (
            <NewSessionPane
              key={`${currentUserId}:${repo.id}`}
              base={base}
              companyId={company.id}
              currentUserId={currentUserId}
              repoId={repo.id}
              repoName={repo.name}
              repoKind={repo.kind}
              accessHref={`/c/${company.slug}/repositories/${repo.slug}/access`}
              candidates={candidates}
              error={candidatesError}
              busy={anyRunning}
              onRetry={reloadList}
              onStarted={async (session) => {
                await reloadList();
                navigate(`${aiBase}/${session.id}`);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── the session inbox ──────────────────────────

function SessionInbox({
  companyId,
  sessions,
  archived,
  error,
  activeId,
  aiBase,
  onRetry,
  onSelect,
  onArchivedChange,
}: {
  companyId: string;
  sessions: RepositoryWorkSession[] | null;
  archived: RepositoryWorkSession[] | null;
  error: string | null;
  activeId: string | null;
  aiBase: string;
  onRetry: () => Promise<void>;
  onSelect: (sessionId: string | null) => void;
  onArchivedChange: (session: RepositoryWorkSession, archived: boolean) => Promise<void>;
}) {
  const [query, setQuery] = React.useState("");
  const [showArchive, setShowArchive] = React.useState(false);
  const archivedRows = archived ?? [];

  /**
   * Opening an archived session — from its own URL, from a colleague's link —
   * switches the list to the archive. Otherwise the sidebar sits there
   * insisting the thing on screen does not exist.
   */
  const activeIsArchived = !!activeId && archivedRows.some((row) => row.id === activeId);
  React.useEffect(() => {
    if (activeIsArchived) setShowArchive(true);
  }, [activeIsArchived]);

  /**
   * The archive is a flat list in the order things were filed away, not the
   * inbox's status grouping. Grouping it would put a "Needs attention" heading
   * over sessions somebody archived precisely to say they need nothing, and
   * would reorder a history whose only useful order is most-recent-first.
   */
  const listed = showArchive ? archivedRows : (sessions ?? []);
  const visible = listed.filter((session) => matchesSessionSearch(session, query));
  const groups = groupSessions(visible);
  const activeMissing =
    !!activeId &&
    !sessions?.some((session) => session.id === activeId) &&
    !archivedRows.some((session) => session.id === activeId);

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-72 xl:w-80">
      {/* A select keeps the session history from becoming a 30rem wall above
        the actual work on phones and tablets. */}
      <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:hidden">
        {sessions === null && !error ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-slate-500 dark:text-slate-400"
          >
            <Spinner size={14} /> Loading work sessions…
          </div>
        ) : error && sessions === null ? (
          <InlineRetry message={error} onRetry={onRetry} compact />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Select
                value={activeId ?? ""}
                onChange={(event) => onSelect(event.target.value || null)}
                aria-label="Open work session"
                containerClassName="min-w-0 flex-1"
                searchPlaceholder="Search work sessions…"
                className="h-9 border-0 bg-slate-50 py-2 font-medium text-slate-700 focus:ring-indigo-500/20 dark:bg-slate-800 dark:text-slate-200 dark:focus:ring-indigo-500/25"
              >
                <option value="">Start a new session</option>
                {activeMissing && <option value={activeId}>Current session</option>}
                {(sessions ?? []).map((session) => (
                  <option
                    key={session.id}
                    value={session.id}
                    data-search-text={sessionSearchText(session)}
                  >
                    {sessionTitle(session)} — {SESSION_STATUS_LABEL[session.status]}
                  </option>
                ))}
                {/* A phone gets no second list to toggle to, so the archive
                  lives here as its own group: still out of the way, still
                  reachable, and still searchable by the same index. */}
                {archivedRows.length > 0 && (
                  <optgroup label="Archived">
                    {archivedRows.map((session) => (
                      <option
                        key={session.id}
                        value={session.id}
                        data-search-text={sessionSearchText(session)}
                      >
                        {sessionTitle(session)} — {SESSION_STATUS_LABEL[session.status]}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </div>
            {error && (
              <div className="mt-2">
                <InlineRetry message={error} onRetry={onRetry} compact />
              </div>
            )}
          </>
        )}
      </div>

      <div className="hidden max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:flex">
        <div className="border-b border-slate-100 p-3 dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {showArchive ? "Archived sessions" : "Work sessions"}
              </h2>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {showArchive
                  ? `${archivedRows.length} archived`
                  : `${sessions?.length ?? 0} recent`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* Hidden until there is something to hide. An empty archive is
                a control that only ever shows an empty list. */}
              {(showArchive || archivedRows.length > 0) && (
                <button
                  type="button"
                  onClick={() => setShowArchive((current) => !current)}
                  aria-pressed={showArchive}
                  title={showArchive ? "Back to the inbox" : "Show archived sessions"}
                  // The visible label is a bare count, which is no name at all
                  // read aloud.
                  aria-label={
                    showArchive
                      ? "Back to the inbox"
                      : `Show ${archivedRows.length} archived session${archivedRows.length === 1 ? "" : "s"}`
                  }
                  className={
                    "inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors " +
                    (showArchive
                      ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      : "text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300")
                  }
                >
                  {showArchive ? <Inbox size={13} /> : <Archive size={13} />}
                  {showArchive ? "Inbox" : archivedRows.length}
                </button>
              )}
              {activeId && (
                <Link to={aiBase} className={buttonClassName({ size: "sm" })}>
                  <Plus size={13} /> New
                </Link>
              )}
            </div>
          </div>
          {listed.length > 4 && (
            <label className="relative mt-3 block">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={showArchive ? "Search archived" : "Search sessions"}
                aria-label={showArchive ? "Search archived sessions" : "Search work sessions"}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-8 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:focus:ring-indigo-500/25"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-2 rounded p-0.5 text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  <X size={12} />
                </button>
              )}
            </label>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions === null && !error ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner size={16} />
            </div>
          ) : error && sessions === null ? (
            <InlineRetry message={error} onRetry={onRetry} compact />
          ) : listed.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
                {showArchive ? <Archive size={16} /> : <Inbox size={16} />}
              </span>
              <p className="mt-3 text-xs font-medium text-slate-600 dark:text-slate-300">
                {showArchive ? "Nothing archived" : "No sessions yet"}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
                {showArchive
                  ? "Archive a finished session to file it away without throwing the work out."
                  : "Your delegated work will stay organized here."}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-slate-500 dark:text-slate-400">
              No session matches &quot;{query}&quot;.
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-2">
                  <InlineRetry message={error} onRetry={onRetry} compact />
                </div>
              )}
              {showArchive && (
                <ul className="space-y-0.5">
                  {visible.map((session) => (
                    <SessionInboxRow
                      key={session.id}
                      companyId={companyId}
                      session={session}
                      active={session.id === activeId}
                      href={`${aiBase}/${session.id}`}
                      onArchivedChange={onArchivedChange}
                    />
                  ))}
                </ul>
              )}
              {!showArchive &&
                SESSION_INBOX_GROUP_ORDER.map((group) => {
                  const rows = groups[group];
                  if (rows.length === 0) return null;
                  return (
                    <section key={group} className="mb-3 last:mb-0">
                      <div className="flex items-center justify-between px-2 pb-1 pt-1">
                        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                          {SESSION_INBOX_GROUP_LABEL[group]}
                        </h3>
                        <span className="font-mono text-[10px] tabular-nums text-slate-300 dark:text-slate-600">
                          {rows.length}
                        </span>
                      </div>
                      <ul className="space-y-0.5">
                        {rows.map((session) => (
                          <SessionInboxRow
                            key={session.id}
                            companyId={companyId}
                            session={session}
                            active={session.id === activeId}
                            href={`${aiBase}/${session.id}`}
                            onArchivedChange={onArchivedChange}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function SessionInboxRow({
  companyId,
  session,
  active,
  href,
  onArchivedChange,
}: {
  companyId: string;
  session: RepositoryWorkSession;
  active: boolean;
  href: string;
  onArchivedChange: (session: RepositoryWorkSession, archived: boolean) => Promise<void>;
}) {
  const tone = SESSION_STATUS_TONE[session.status];
  const employeeName = session.employee?.name ?? "Removed employee";
  const archived = isArchived(session);
  const [busy, setBusy] = React.useState(false);
  // A turn in flight is the one thing that must not be filed away mid-work,
  // and it is the one thing the server refuses too.
  const canArchive = session.status !== "running";

  async function toggle() {
    setBusy(true);
    try {
      await onArchivedChange(session, !archived);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="group/row relative">
      <Link
        to={href}
        aria-current={active ? "page" : undefined}
        className={
          "group flex items-start gap-2.5 rounded-lg py-2.5 pl-2.5 pr-9 transition-colors " +
          (active
            ? "bg-indigo-50 ring-1 ring-inset ring-indigo-100 dark:bg-indigo-500/10 dark:ring-indigo-500/20"
            : "hover:bg-slate-50 dark:hover:bg-slate-800/60")
        }
      >
        <Avatar
          name={employeeName}
          kind="ai"
          size="sm"
          className="mt-0.5 shrink-0"
          src={
            session.employee
              ? employeeAvatarUrl(companyId, session.employee.id, session.employee.avatarKey)
              : null
          }
        />
        <span className="min-w-0 flex-1">
          <span
            className={
              "block truncate text-[13px] leading-5 " +
              (active
                ? "font-semibold text-slate-900 dark:text-slate-50"
                : "font-medium text-slate-700 dark:text-slate-200")
            }
          >
            {sessionTitle(session)}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
            {session.status === "running" ? (
              <Spinner size={9} />
            ) : (
              <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + DOT_CLASS[tone]} />
            )}
            <span className="truncate">{sessionSubtitle(session)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{formatRelative(session.updatedAt)}</span>
          </span>
          {session.filesChanged > 0 && (
            <span className="mt-1 inline-flex font-mono text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
              {session.filesChanged} {session.filesChanged === 1 ? "file" : "files"} ·
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                +{session.insertions}
              </span>
              <span className="ml-1 text-rose-600 dark:text-rose-400">−{session.deletions}</span>
            </span>
          )}
        </span>
      </Link>
      {/* Outside the Link, not inside it: a button nested in an anchor is
        invalid markup and swallows the navigation people expect from the rest
        of the row. Kept visible on focus so it is reachable by keyboard, and
        always visible on touch, where there is no hover to reveal it with. */}
      {canArchive && (
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          title={archived ? "Put this session back in the inbox" : "Archive this session"}
          aria-label={
            archived ? `Restore ${sessionTitle(session)}` : `Archive ${sessionTitle(session)}`
          }
          className="absolute right-1.5 top-2 rounded p-1 text-slate-300 opacity-0 transition-opacity hover:bg-slate-200 hover:text-slate-600 focus-visible:opacity-100 disabled:opacity-50 group-hover/row:opacity-100 dark:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200 [@media(hover:none)]:opacity-100"
        >
          {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
      )}
    </li>
  );
}

// ────────────────────────── starting a session ──────────────────────────

export function NewSessionPane({
  base,
  companyId,
  currentUserId,
  repoId,
  repoName,
  repoKind,
  accessHref,
  candidates,
  error,
  busy,
  onRetry,
  onStarted,
}: {
  base: string;
  companyId: string;
  currentUserId: string;
  repoId: string;
  repoName: string;
  repoKind: string;
  accessHref: string;
  candidates: RepositoryWorkSessionCandidatesResponse["employees"] | null;
  error: string | null;
  /** Another session is running — worth saying, not worth blocking on. */
  busy: boolean;
  onRetry: () => Promise<void>;
  onStarted: (session: RepositoryWorkSession) => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [modelOverride, setModelOverride] = React.useState<WorkSessionModelOverride | null>(null);
  const [effortOverride, setEffortOverride] = React.useState<{
    employeeId: string;
    modelId: string;
    effort: ModelEffort;
  } | null>(null);
  const [instruction, setInstruction] = usePersistedDraft(
    `repository-ai-draft:${currentUserId}:${repoId}`,
  );
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const submitting = React.useRef(false);
  const attachments = useChatAttachments({
    scopeKey: `${currentUserId}:${repoId}`,
    upload: (file) => api.uploadFile<ChatAttachment>(`${base}/session-attachments`, file),
    onError: setStartError,
  });
  const { onPaste, dragProps, dragActive } = useComposerFileDrop(
    (files) => void attachments.addFiles(files),
    { disabled: starting || !candidates?.length },
  );
  const selected = candidates?.find((candidate) => candidate.id === employeeId) ?? candidates?.[0];
  const selectedModelId = selected
    ? resolveWorkSessionModelId({
        employeeId: selected.id,
        models: selected.models,
        override: modelOverride,
      })
    : null;
  const effortLevels = selected?.models.find((model) => model.id === selectedModelId)?.effortLevels;
  const selectedEffort =
    effortOverride &&
    effortOverride.employeeId === selected?.id &&
    effortOverride.modelId === selectedModelId &&
    effortLevels?.includes(effortOverride.effort)
      ? effortOverride.effort
      : null;
  React.useEffect(() => {
    // A live model or Grant update can invalidate a choice while the brief stays open.
    if (effortOverride && !selectedEffort) setEffortOverride(null);
  }, [effortOverride, selectedEffort]);

  if (candidates === null) {
    return error ? <InlineRetry message={error} onRetry={onRetry} /> : <NewSessionSkeleton />;
  }

  if (!selected) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-7 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <Users size={18} />
            </span>
            <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
              No employee can work here yet
            </div>
            <p className="mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">
              Grant an AI employee access to this repository first. Only employees with a grant get
              a checkout, so only they can be asked to do work in it.
            </p>
          </div>
          <Link
            to={accessHref}
            className={buttonClassName({ variant: "secondary", className: "shrink-0" })}
          >
            <Users size={15} /> Manage AI access
          </Link>
        </div>
      </section>
    );
  }

  async function start() {
    if (!selected || !selectedModelId || submitting.current || attachments.isUploading()) return;
    setStartError(null);
    if (!instruction.trim() && !attachments.pending.length) {
      setStartError("Say what the employee should do.");
      return;
    }
    submitting.current = true;
    setStarting(true);
    try {
      const session = await api.post<RepositoryWorkSession>(`${base}/sessions`, {
        employeeId: selected.id,
        modelId: selectedModelId,
        effort: selectedEffort,
        instruction: instruction.trim(),
        attachmentIds: attachments.pending.map((attachment) => attachment.id),
      });
      setInstruction("");
      attachments.clear();
      await onStarted(session);
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      submitting.current = false;
      setStarting(false);
    }
  }

  const placeholder =
    repoKind === "documents"
      ? "What should change in these documents? Include the audience, outcome, and any boundaries."
      : "What should change in this repository? Include the expected behavior and how to verify it.";
  const starters = STARTERS[repoKind === "documents" ? "documents" : "code"];

  return (
    <div className="space-y-4">
      {error && <InlineRetry message={error} onRetry={onRetry} compact />}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-5 dark:border-slate-800 dark:bg-slate-950/20 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-500 dark:text-indigo-300">
                <Sparkles size={13} /> New work session
              </div>
              <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                What outcome do you want?
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
                Give the employee a clear finish line. You can review every change and ask for
                another pass before accepting anything.
              </p>
            </div>
            {selected && (
              <div className="flex shrink-0 items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                <Avatar
                  name={selected.name}
                  kind="ai"
                  size="md"
                  src={employeeAvatarUrl(companyId, selected.id, selected.avatarKey)}
                />
                <div className="min-w-0">
                  <div className="max-w-40 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {selected.name}
                  </div>
                  <div className="max-w-40 truncate text-[11px] text-slate-400 dark:text-slate-500">
                    {selected.role}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap gap-2">
            {starters.map((starter) => (
              <button
                key={starter.label}
                type="button"
                onClick={() => setInstruction(starter.prompt)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500/30 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300"
              >
                {starter.label}
              </button>
            ))}
          </div>

          <div
            {...dragProps}
            className={
              (dragActive ? "ring-2 ring-indigo-400 " : "") +
              "overflow-hidden rounded-xl border border-slate-200 bg-white focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-indigo-700 dark:focus-within:ring-indigo-900/30"
            }
          >
            <textarea
              value={instruction}
              onPaste={onPaste}
              disabled={starting}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
              }}
              rows={8}
              maxLength={20000}
              autoFocus
              placeholder={placeholder}
              aria-label="Work brief"
              className="w-full resize-y border-0 bg-transparent px-4 py-3 text-sm leading-6 text-slate-700 placeholder:text-slate-400 focus:outline-none dark:text-slate-200 dark:placeholder:text-slate-500"
            />
            <div className="px-3">
              <ChatAttachments
                attachments={attachments.pending}
                urlFor={(id) => `${base}/session-attachments/${id}`}
                onRemove={starting ? undefined : attachments.remove}
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                aria-label="Attach files to work brief"
                onChange={(event) => {
                  if (event.target.files) void attachments.addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                disabled={starting || attachments.pending.length + attachments.uploading >= 10}
                onClick={() => fileInput.current?.click()}
                className="mb-2 inline-flex items-center gap-1.5 text-xs text-slate-500 disabled:opacity-50"
              >
                {attachments.uploading ? <Spinner size={13} /> : <Paperclip size={13} />}
                {attachments.uploading ? "Uploading…" : "Attach files or paste an image"}
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck size={12} /> Isolated branch
                </span>
                {instruction && (
                  <span className="inline-flex items-center gap-1">
                    <CircleCheck size={12} /> Draft saved
                  </span>
                )}
                <span className="font-mono tabular-nums">
                  {instruction.length.toLocaleString()} / 20,000
                </span>
              </div>
              <span className="text-[10px] text-slate-400 dark:text-slate-500">⌘↵ to start</span>
            </div>
          </div>

          <FormError message={startError} className="mt-4" />

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <Select
                label="AI employee"
                value={selected.id}
                disabled={starting}
                containerClassName="w-full sm:w-52"
                onChange={(event) => {
                  setEmployeeId(event.target.value);
                  setModelOverride(null);
                  setEffortOverride(null);
                  setStartError(null);
                }}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id} data-search-text={candidate.role}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
              <WorkSessionModelPicker
                models={selected.models}
                modelId={selectedModelId}
                disabled={starting}
                onChange={(modelId) => {
                  setModelOverride({ employeeId: selected.id, modelId });
                  setEffortOverride(null);
                  setStartError(null);
                }}
              />
              {!!effortLevels?.length && (
                <Select
                  label="Effort"
                  value={selectedEffort ?? ""}
                  disabled={starting}
                  containerClassName="w-full min-w-0 sm:w-44"
                  onChange={(event) => {
                    const effort = effortLevels.find((level) => level === event.target.value);
                    setEffortOverride(
                      effort && selectedModelId
                        ? { employeeId: selected.id, modelId: selectedModelId, effort }
                        : null,
                    );
                    setStartError(null);
                  }}
                >
                  <option value="">Model default</option>
                  {effortLevels.map((effort) => (
                    <option key={effort} value={effort}>
                      {MODEL_EFFORT_LABELS[effort]}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <Button
              onClick={start}
              disabled={
                starting ||
                attachments.uploading > 0 ||
                !selectedModelId ||
                (!instruction.trim() && !attachments.pending.length)
              }
              className="w-full justify-center sm:w-auto"
            >
              {starting ? <Spinner size={14} /> : <Sparkles size={14} />}
              {starting ? "Starting…" : `Start with ${selected?.name ?? "AI"}`}
            </Button>
          </div>

          {!selectedModelId && (
            <p role="status" className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Connect an AI Model for {selected.name} before starting a Work session.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <span>
              {busy
                ? "Other work is already running. This session gets its own copy and will not collide."
                : `Nothing reaches ${repoName} until a Member accepts it.`}
            </span>
            <Link
              to={accessHref}
              className="font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-300"
            >
              Manage AI access
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────── an open session ────────────────────────────

function NewSessionSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-100 bg-slate-50/50 p-6 dark:border-slate-800 dark:bg-slate-950/20">
        <div className="h-3 w-28 rounded bg-slate-200 dark:bg-slate-700" />
        <div className="mt-3 h-6 w-72 max-w-full rounded bg-slate-200 dark:bg-slate-700" />
        <div className="mt-2 h-3 w-96 max-w-full rounded bg-slate-100 dark:bg-slate-800" />
      </div>
      <div className="p-6">
        <div className="h-48 rounded-xl bg-slate-100 dark:bg-slate-800" />
        <div className="mt-4 h-9 w-48 rounded-lg bg-slate-100 dark:bg-slate-800" />
      </div>
    </div>
  );
}
