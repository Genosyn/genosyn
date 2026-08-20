import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  Inbox,
  Lock,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button, buttonClassName } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { formatRelative } from "../components/decisions/relative";
import { DiffStats, DiffView } from "../components/repositories/DiffView";
import {
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TONE,
  SESSION_INBOX_GROUP_LABEL,
  SESSION_INBOX_GROUP_ORDER,
  type SessionStatusTone,
  groupSessions,
  hasReviewableWork,
  isGithubRemote,
  matchesSessionSearch,
  sessionActions,
  sessionSubtitle,
  sessionTitle,
  sortSessions,
} from "../components/repositories/sessionState";
import {
  api,
  RepositoryCommit,
  RepositoryStatus,
  RepositoryWorkSession,
  RepositoryWorkSessionCandidatesResponse,
  RepositoryWorkSessionDetail,
  RepositoryWorkSessionDiff,
  RepositoryWorkSessionTurn,
  RepositoryWorkSessionsResponse,
} from "../lib/api";
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

/** A running turn can take minutes, so the open session is polled as well. */
const RUNNING_POLL_MS = 4000;

type WorkspaceView = "activity" | "changes";

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

/** Keep an unfinished brief through navigation and accidental refreshes. */
function usePersistedDraft(
  storageKey: string,
): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [value, setValue] = React.useState(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });

  React.useEffect(() => {
    try {
      if (value) window.localStorage.setItem(storageKey, value);
      else window.localStorage.removeItem(storageKey);
    } catch {
      // A blocked storage API should never block someone from delegating work.
    }
  }, [storageKey, value]);

  return [value, setValue];
}

const TONE_CLASS: Record<SessionStatusTone, string> = {
  working: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  review: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  quiet: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  bad: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
};

const DOT_CLASS: Record<SessionStatusTone, string> = {
  working: "bg-indigo-500",
  review: "bg-amber-500",
  quiet: "bg-slate-300 dark:bg-slate-600",
  good: "bg-emerald-500",
  bad: "bg-rose-500",
};

export default function RepositoryAi() {
  const { company, currentUserId, repo } = useRepositoriesContext();
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();

  const base = repo ? `/api/companies/${company.id}/repositories/${repo.slug}` : "";
  const aiBase = repo ? `/c/${company.slug}/repositories/${repo.slug}/ai` : "";
  const repoId = repo?.id ?? null;
  const isRemote = repo?.origin === "remote";
  const isGithub = isGithubRemote(repo?.gitUrl);
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
    const [sessionRows, candidateRows, status] = await Promise.allSettled([
      api.get<RepositoryWorkSessionsResponse>(`${base}/sessions`),
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
    setCandidates(null);
    setSessionsError(null);
    setCandidatesError(null);
    setCheckoutBranch(null);
    void reloadList();
  }, [reloadList]);

  useLiveRefetch("repository", reloadList, repoId);

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
          error={sessionsError}
          activeId={sessionId ?? null}
          aiBase={aiBase}
          onRetry={reloadList}
          onSelect={(id) => navigate(id ? `${aiBase}/${id}` : aiBase)}
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
              allowPullRequest={isRemote && isGithub}
              canReachRemote={canReachRemote}
              checkoutBranch={checkoutBranch}
              dialog={dialog}
              toast={toast}
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
              toast={toast}
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
  error,
  activeId,
  aiBase,
  onRetry,
  onSelect,
}: {
  companyId: string;
  sessions: RepositoryWorkSession[] | null;
  error: string | null;
  activeId: string | null;
  aiBase: string;
  onRetry: () => Promise<void>;
  onSelect: (sessionId: string | null) => void;
}) {
  const [query, setQuery] = React.useState("");
  const visible = (sessions ?? []).filter((session) => matchesSessionSearch(session, query));
  const groups = groupSessions(visible);
  const activeMissing = !!activeId && !sessions?.some((session) => session.id === activeId);

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
                className="h-9 border-0 bg-slate-50 py-2 font-medium text-slate-700 focus:ring-indigo-100 dark:bg-slate-800 dark:text-slate-200 dark:focus:ring-indigo-900/30"
              >
                <option value="">Start a new session</option>
                {activeMissing && <option value={activeId}>Current session</option>}
                {(sessions ?? []).map((session) => (
                  <option key={session.id} value={session.id}>
                    {sessionTitle(session)} — {SESSION_STATUS_LABEL[session.status]}
                  </option>
                ))}
              </Select>
              {activeId && (
                <Link
                  to={aiBase}
                  className={buttonClassName({ size: "sm", className: "shrink-0" })}
                >
                  <Plus size={14} /> New
                </Link>
              )}
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
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Work sessions
              </h2>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {sessions?.length ?? 0} recent
              </p>
            </div>
            {activeId && (
              <Link to={aiBase} className={buttonClassName({ size: "sm" })}>
                <Plus size={13} /> New
              </Link>
            )}
          </div>
          {sessions !== null && sessions.length > 4 && (
            <label className="relative mt-3 block">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions"
                aria-label="Search work sessions"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-8 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
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
          ) : sessions?.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
                <Inbox size={16} />
              </span>
              <p className="mt-3 text-xs font-medium text-slate-600 dark:text-slate-300">
                No sessions yet
              </p>
              <p className="mt-1 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
                Your delegated work will stay organized here.
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
              {SESSION_INBOX_GROUP_ORDER.map((group) => {
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
}: {
  companyId: string;
  session: RepositoryWorkSession;
  active: boolean;
  href: string;
}) {
  const tone = SESSION_STATUS_TONE[session.status];
  const employeeName = session.employee?.name ?? "Removed employee";
  return (
    <li className="relative">
      <Link
        to={href}
        aria-current={active ? "page" : undefined}
        className={
          "group flex items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors " +
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
    </li>
  );
}

// ────────────────────────── starting a session ──────────────────────────

function NewSessionPane({
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
  toast,
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
  toast: (message: string, kind?: "success" | "error") => void;
  onRetry: () => Promise<void>;
  onStarted: (session: RepositoryWorkSession) => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [instruction, setInstruction] = usePersistedDraft(
    `repository-ai-draft:${currentUserId}:${repoId}`,
  );
  const [starting, setStarting] = React.useState(false);

  React.useEffect(() => {
    if (!candidates || candidates.length === 0) {
      setEmployeeId("");
      return;
    }
    setEmployeeId((current) =>
      candidates.some((candidate) => candidate.id === current) ? current : candidates[0].id,
    );
  }, [candidates]);

  if (candidates === null) {
    return error ? <InlineRetry message={error} onRetry={onRetry} /> : <NewSessionSkeleton />;
  }

  if (candidates.length === 0) {
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
    if (!employeeId) return;
    if (!instruction.trim()) {
      toast("Say what the employee should do.", "error");
      return;
    }
    setStarting(true);
    try {
      const session = await api.post<RepositoryWorkSession>(`${base}/sessions`, {
        employeeId,
        instruction: instruction.trim(),
      });
      setInstruction("");
      const who = candidates?.find((candidate) => candidate.id === employeeId)?.name;
      toast(`${who ?? "The employee"} is on it. Follow along in this session.`, "success");
      await onStarted(session);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setStarting(false);
    }
  }

  const placeholder =
    repoKind === "documents"
      ? "What should change in these documents? Include the audience, outcome, and any boundaries."
      : "What should change in this repository? Include the expected behavior and how to verify it.";
  const selected = candidates.find((candidate) => candidate.id === employeeId) ?? candidates[0];
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

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-indigo-700 dark:focus-within:ring-indigo-900/30">
            <textarea
              value={instruction}
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

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 max-w-sm">
              <Select
                label="AI employee"
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} — {candidate.role}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              onClick={start}
              disabled={starting || !employeeId || !instruction.trim()}
              className="w-full justify-center sm:w-auto"
            >
              {starting ? <Spinner size={14} /> : <Sparkles size={14} />}
              {starting ? "Starting…" : `Start with ${selected?.name ?? "AI"}`}
            </Button>
          </div>

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

function SessionPane({
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
  toast,
  onChanged,
  onGone,
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
  toast: (message: string, kind?: "success" | "error") => void;
  onChanged: () => Promise<void>;
  onGone: () => void;
}) {
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
   * The last action's failure, kept on the page rather than only in a toast.
   * A toast that says a pull request could not be opened is gone by the time
   * someone has finished reading it, and these messages are instructions.
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
      <InlineRetry message={detailError} onRetry={reload} onBack={onGone} />
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
      const message = err instanceof Error ? err.message : String(err);
      setFailure(message);
      toast(message, "error");
    } finally {
      setActing(false);
    }
  }

  async function send() {
    const text = instruction.trim();
    if (!text) {
      toast("Say what should change.", "error");
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
      const message = err instanceof Error ? err.message : String(err);
      // The banner, not only a toast: this is the one action whose failure
      // message people need while they retype the instruction.
      setFailure(message);
      toast(message, "error");
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
      toast(push ? "Accepted and sent" : `Accepted into ${target}`, "success");
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
      const updated = await api.post<RepositoryWorkSession>(
        `${base}/sessions/${sessionId}/pull-request`,
        {},
      );
      await reload();
      await onChanged();
      toast(
        updated.pullRequestNumber
          ? `Pull request #${updated.pullRequestNumber} is ${isUpdate ? "up to date" : "open"}`
          : "Pull request opened",
        "success",
      );
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
      toast("Work thrown away", "success");
    });
  }

  async function saveTitle() {
    const next = (renaming ?? "").trim();
    setRenaming(null);
    if (!next || next === session?.title) return;
    try {
      await api.patch(`${base}/sessions/${sessionId}`, { title: next });
      await reload();
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const hasActions =
    actions.accept || actions.acceptAndSend || actions.pullRequest || actions.discard;
  const changesReady = !!session.headCommit;

  return (
    <section className="flex min-w-0 flex-col">
      <header className="sticky top-0 z-20 overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
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

        <div className="flex border-t border-slate-100 px-2 dark:border-slate-800 min-[1800px]:hidden">
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
        <div className="mt-3">
          <InlineRetry message={detailError} onRetry={reload} compact />
        </div>
      )}

      {failure && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/5 dark:text-rose-300">
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

      <div className="mt-4 min-w-0 gap-4 min-[1800px]:grid min-[1800px]:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
        <section
          className={
            (view === "activity" ? "flex" : "hidden") +
            " min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 min-[1800px]:flex"
          }
        >
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

          <div className="min-h-[20rem] flex-1 space-y-6 px-4 py-5 sm:px-5 min-[1800px]:max-h-[calc(100vh-21rem)] min-[1800px]:overflow-y-auto">
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

        <section
          className={
            (view === "changes" ? "flex" : "hidden") +
            " min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 min-[1800px]:flex"
          }
        >
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

          <div className="min-h-[20rem] flex-1 overflow-y-auto bg-slate-50/40 p-3 dark:bg-slate-950/20 sm:p-4 min-[1800px]:max-h-[calc(100vh-21rem)]">
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

function InlineRetry({
  message,
  onRetry,
  onBack,
  compact = false,
}: {
  message: string;
  onRetry: () => Promise<void>;
  onBack?: () => void;
  compact?: boolean;
}) {
  const [retrying, setRetrying] = React.useState(false);
  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }
  return (
    <div
      role="alert"
      className={
        "flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/60 text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/5 dark:text-rose-300 " +
        (compact ? "px-3 py-2 text-xs" : "px-4 py-4 text-sm")
      }
    >
      <AlertCircle size={compact ? 14 : 16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-words leading-5">{message}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void retry()}
            disabled={retrying}
            className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 disabled:opacity-60 dark:bg-slate-900 dark:text-rose-300 dark:ring-rose-500/25 dark:hover:bg-rose-500/10"
          >
            {retrying ? <Spinner size={11} /> : <RefreshCw size={11} />}
            Retry
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-xs font-medium text-rose-600 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200"
            >
              Back to sessions
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
