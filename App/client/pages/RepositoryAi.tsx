import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Lock,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
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
  type SessionStatusTone,
  isGithubRemote,
  sessionActions,
  sessionSubtitle,
  sessionTitle,
  sortSessions,
} from "../components/repositories/sessionState";
import {
  api,
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
 * tool: a list of sessions on the left, one open session on the right, and a
 * composer pinned to the bottom of it that keeps the conversation going. A
 * session is not a single request. You ask, you read the diff, you say "close,
 * but keep the old heading", and the same employee picks up in the same
 * working copy on the same branch.
 *
 * Three things shape the layout, and all three came from watching the old one
 * fail:
 *
 *   1. **The transcript is the page.** It used to be squeezed between a header
 *      card, a diff card, an action card and a composer card, each with its
 *      own border, so the actual conversation had perhaps a third of the
 *      screen. Chrome is now one bar at the top and one at the bottom.
 *   2. **The diff is opened, not shown.** A change touching thirty files used
 *      to render all thirty expanded. `DiffView` now leads with the summary.
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
  const { company, repo } = useRepositoriesContext();
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
    RepositoryWorkSessionCandidatesResponse["employees"]
  >([]);
  /** Where accepted work lands. Null until the first status read comes back. */
  const [checkoutBranch, setCheckoutBranch] = React.useState<string | null>(null);

  const reloadList = React.useCallback(async () => {
    if (!base) return;
    try {
      const [sessionRows, candidateRows, status] = await Promise.all([
        api.get<RepositoryWorkSessionsResponse>(`${base}/sessions`),
        api.get<RepositoryWorkSessionCandidatesResponse>(`${base}/session-candidates`),
        // Accepting work merges it into whatever branch this checkout is on,
        // and the page used to ask people to approve that without ever naming
        // it. One extra read buys the sentence its missing fact.
        api.get<RepositoryStatus>(`${base}/workspace/status`).catch(() => null),
      ]);
      setSessions(sortSessions(sessionRows.sessions));
      setCandidates(candidateRows.employees);
      setCheckoutBranch(status?.branch ?? null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setSessions([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    setSessions(null);
    setCheckoutBranch(null);
    reloadList();
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
  const openSession = sessionId ? (rows.find((row) => row.id === sessionId) ?? null) : null;
  const anyRunning = rows.some((row) => row.status === "running");

  return (
    <div className="pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              AI work
            </h1>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">
              An AI employee works on its own copy of {repo.name}. Nothing is kept until you say so.
            </p>
          </div>
        </div>
        {sessionId && (
          <Link to={aiBase} className="shrink-0">
            <Button size="sm" variant="secondary">
              <Plus size={14} /> New session
            </Button>
          </Link>
        )}
      </div>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
        <SessionSwitcher
          companyId={company.id}
          sessions={sessions}
          activeId={sessionId ?? null}
          aiBase={aiBase}
        />

        <div className="min-w-0 flex-1">
          {sessionId ? (
            sessions !== null && !openSession ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                That session is not in this repository any more.
              </div>
            ) : (
              <SessionPane
                key={sessionId}
                companyId={company.id}
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
            )
          ) : (
            <NewSessionPane
              base={base}
              repoName={repo.name}
              repoKind={repo.kind}
              accessHref={`/c/${company.slug}/repositories/${repo.slug}/access`}
              candidates={candidates}
              busy={anyRunning}
              toast={toast}
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

// ─────────────────────────── the session list ───────────────────────────

function SessionSwitcher({
  companyId,
  sessions,
  activeId,
  aiBase,
}: {
  companyId: string;
  sessions: RepositoryWorkSession[] | null;
  activeId: string | null;
  aiBase: string;
}) {
  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-64">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Sessions
        </h2>
        {activeId && (
          <Link
            to={aiBase}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
          >
            <Plus size={11} /> New
          </Link>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {sessions === null ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No sessions yet. Describe a change and one starts here.
          </p>
        ) : (
          <ul className="max-h-[30rem] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {sessions.map((session) => {
              const tone = SESSION_STATUS_TONE[session.status];
              const active = session.id === activeId;
              return (
                <li key={session.id} className="relative">
                  {active && (
                    <span
                      className="absolute inset-y-0 left-0 w-0.5 bg-indigo-500"
                      aria-hidden
                    />
                  )}
                  <Link
                    to={`${aiBase}/${session.id}`}
                    aria-current={active ? "true" : undefined}
                    className={
                      "flex items-start gap-2 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 " +
                      (active ? "bg-indigo-50/60 dark:bg-indigo-500/10" : "")
                    }
                  >
                    <span className="mt-1.5 shrink-0">
                      {session.status === "running" ? (
                        <Spinner size={10} />
                      ) : (
                        <span
                          className={"block h-1.5 w-1.5 rounded-full " + DOT_CLASS[tone]}
                          aria-hidden
                        />
                      )}
                    </span>
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
                      <span className="mt-1 flex items-center gap-1.5">
                        <Avatar
                          name={session.employee?.name ?? "Removed employee"}
                          kind="ai"
                          size="xs"
                          src={
                            session.employee
                              ? employeeAvatarUrl(
                                  companyId,
                                  session.employee.id,
                                  session.employee.avatarKey,
                                )
                              : null
                          }
                        />
                        <span className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                          {sessionSubtitle(session)}
                        </span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                        <span>{SESSION_STATUS_LABEL[session.status]}</span>
                        <span aria-hidden>·</span>
                        <span>{formatRelative(session.updatedAt)}</span>
                        {session.filesChanged > 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono tabular-nums">
                              {session.filesChanged}f
                            </span>
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ────────────────────────── starting a session ──────────────────────────

function NewSessionPane({
  base,
  repoName,
  repoKind,
  accessHref,
  candidates,
  busy,
  toast,
  onStarted,
}: {
  base: string;
  repoName: string;
  repoKind: string;
  accessHref: string;
  candidates: RepositoryWorkSessionCandidatesResponse["employees"];
  /** Another session is running — worth saying, not worth blocking on. */
  busy: boolean;
  toast: (message: string, kind?: "success" | "error") => void;
  onStarted: (session: RepositoryWorkSession) => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  const [starting, setStarting] = React.useState(false);

  React.useEffect(() => {
    if (candidates.length === 0) {
      setEmployeeId("");
      return;
    }
    setEmployeeId((current) =>
      candidates.some((candidate) => candidate.id === current) ? current : candidates[0].id,
    );
  }, [candidates]);

  if (candidates.length === 0) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              No employee can work here yet
            </div>
            <p className="mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">
              Grant an AI employee access to this repository first. Only employees with a grant get
              a checkout, so only they can be asked to do work in it.
            </p>
          </div>
          <Link to={accessHref} className="shrink-0">
            <Button variant="secondary">
              <Users size={15} /> Manage AI access
            </Button>
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
      const who = candidates.find((candidate) => candidate.id === employeeId)?.name;
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
      ? "Rewrite the pricing section of docs/positioning.md to lead with the enterprise tier, and commit it."
      : "Add a health check endpoint, cover it with a test, and commit.";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Start a session
        </h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Say what needs doing. You can keep asking for changes once the first attempt is back.
        </p>
      </div>
      <div className="flex flex-col gap-4 p-5">
        <div className="max-w-sm">
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
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
          }}
          rows={6}
          placeholder={placeholder}
          className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {busy
              ? "Another session is running. Starting this one is fine — they work on separate copies."
              : `Nothing reaches ${repoName} until you accept it.`}
          </span>
          <Button onClick={start} disabled={starting || !employeeId}>
            {starting ? <Spinner size={14} /> : <Sparkles size={14} />}
            {starting ? "Starting…" : "Start work"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────── an open session ────────────────────────────

function SessionPane({
  companyId,
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
  const [showDiff, setShowDiff] = React.useState(true);
  const [instruction, setInstruction] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [acting, setActing] = React.useState(false);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  /**
   * The last action's failure, kept on the page rather than only in a toast.
   * A toast that says a pull request could not be opened is gone by the time
   * someone has finished reading it, and these messages are instructions.
   */
  const [failure, setFailure] = React.useState<string | null>(null);
  const transcriptEnd = React.useRef<HTMLDivElement | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setDetail(await api.get<RepositoryWorkSessionDetail>(`${base}/sessions/${sessionId}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      onGone();
    }
  }, [base, sessionId, toast, onGone]);

  // Opening a *different* session blanks the pane; re-reading the same one
  // must not, or a background refresh replaces what someone is reading with a
  // spinner.
  React.useEffect(() => {
    setDetail(null);
    setDiff(undefined);
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
    try {
      setDiff(await api.get<RepositoryWorkSessionDiff>(`${base}/sessions/${sessionId}/diff`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setDiff(undefined);
    }
  }, [base, sessionId, toast]);

  // Re-read the diff whenever the branch moves, so a revision's changes appear
  // without anyone having to collapse and reopen the panel.
  React.useEffect(() => {
    if (running || !headCommit) return;
    setDiff(null);
    loadDiff();
  }, [running, headCommit, loadDiff]);

  // Only when the transcript actually grows. Scrolling on the first render
  // would yank someone who just opened an old session to the bottom of it.
  const turnCount = detail?.turns.length ?? 0;
  const lastTurnCount = React.useRef(turnCount);
  React.useEffect(() => {
    if (turnCount > lastTurnCount.current) {
      transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    lastTurnCount.current = turnCount;
  }, [turnCount]);

  if (!session) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={20} />
      </div>
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
      message: `Nothing ${employeeName} changed is kept, and ${repoName} stays exactly as it is. The session stays in the list so you can see what was asked for.`,
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

  return (
    <section className="flex min-w-0 flex-col">
      <header className="sticky top-0 z-20 -mx-1 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {renaming === null ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="min-w-0 truncate text-[15px] font-semibold text-slate-900 dark:text-slate-100">
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
                className="rounded p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X size={14} />
              </button>
            </div>
          )}
          <span
            className={
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
              TONE_CLASS[tone]
            }
          >
            {running && <Spinner size={10} />}
            {SESSION_STATUS_LABEL[session.status]}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={employeeName} kind="ai" size="xs" src={avatarSrc} />
            {employeeName}
          </span>
          {session.branch && (
            <span
              className="inline-flex items-center gap-1 font-mono"
              title={`Committed on ${session.branch}`}
            >
              <GitBranch size={11} /> {session.branch}
            </span>
          )}
          {session.filesChanged > 0 && (
            <DiffStats
              filesChanged={session.filesChanged}
              insertions={session.insertions}
              deletions={session.deletions}
              className="text-[11px]"
            />
          )}
          {session.publishedBranch && (
            <span className="inline-flex items-center gap-1" title="This branch is on the remote">
              <Upload size={11} /> pushed
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
              {session.pullRequestNumber ? `#${session.pullRequestNumber}` : "Pull request"}
              <ExternalLink size={10} />
            </a>
          )}
        </div>

        {hasActions && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
            {actions.pullRequest && (
              <Button size="sm" onClick={() => void openPullRequest(actions.pullRequestIsUpdate)} disabled={acting}>
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
      </header>

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

      <div className="mt-4 flex flex-col gap-5">
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

      {session.status !== "running" && session.headCommit && (
        <section className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setShowDiff((current) => !current)}
            aria-expanded={showDiff}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            {showDiff ? (
              <ChevronDown size={15} className="text-slate-400" />
            ) : (
              <ChevronRight size={15} className="text-slate-400" />
            )}
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Everything this session changed
            </span>
            <DiffStats
              className="ml-auto"
              filesChanged={session.filesChanged}
              insertions={session.insertions}
              deletions={session.deletions}
            />
          </button>
          {showDiff && (
            <div className="border-t border-slate-100 bg-slate-50/50 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/30">
              {diff === null || diff === undefined ? (
                <div className="flex h-24 items-center justify-center">
                  <Spinner size={18} />
                </div>
              ) : (
                <DiffView
                  patch={diff.patch}
                  truncated={diff.truncated}
                  filesChanged={session.filesChanged}
                  emptyMessage="This branch has no file changes."
                />
              )}
            </div>
          )}
        </section>
      )}

      {actions.revise ? (
        <div className="sticky bottom-0 z-10 mt-5 rounded-xl border border-slate-200 bg-white/95 p-2.5 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
            }}
            rows={2}
            placeholder={`Ask ${employeeName} for changes — it picks up where it left off, on the same branch.`}
            className="w-full resize-y rounded-lg border-0 bg-transparent px-2 py-1.5 text-sm leading-6 text-slate-700 placeholder:text-slate-400 focus:outline-none dark:text-slate-200 dark:placeholder:text-slate-500"
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="truncate text-[11px] text-slate-400 dark:text-slate-500">
              Another commit on the same branch — nothing it already did is lost.
            </span>
            <Button size="sm" onClick={() => void send()} disabled={sending || !instruction.trim()}>
              {sending ? <Spinner size={13} /> : <ArrowUp size={13} />}
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-5 rounded-xl border border-dashed border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {session.status === "running"
            ? `${employeeName} is working. You can send more instructions when this turn is done.`
            : session.status === "published"
              ? "This work has been accepted. Start a new session for anything further."
              : "This session was thrown away. Start a new one for anything further."}
        </p>
      )}
    </section>
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
          You asked · {formatRelative(turn.createdAt)}
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 dark:text-slate-200">
          {turn.instruction}
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <Avatar name={employeeName} kind="ai" size="sm" src={avatarSrc} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          {turn.status === "running" ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              <Spinner size={14} />
              <span>
                {employeeName} is working. This updates itself when the turn ends.
              </span>
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
