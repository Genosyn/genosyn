import React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  Sparkles,
  Trash2,
  Upload,
  Users,
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
  api,
  RepositoryWorkSession,
  RepositoryWorkSessionCandidatesResponse,
  RepositoryWorkSessionDiff,
  RepositoryWorkSessionStatus,
  RepositoryWorkSessionsResponse,
} from "../lib/api";
import { useRepositoriesContext } from "./RepositoriesLayout";

/**
 * Ask an AI Employee to do work in this repository, then review what it did.
 *
 * The employee never touches the checkout this page reads from. It works in
 * its own, credential-free copy; the server records the branch and the diff,
 * and nothing moves across until a Member presses Merge here. That review step
 * is the whole point of the screen — the composer is the easy half.
 */

/** A running turn can take minutes, so the list is polled as well as pushed. */
const RUNNING_POLL_MS = 4000;

const STATUS_META: Record<RepositoryWorkSessionStatus, { label: string; className: string }> = {
  running: {
    label: "Working",
    className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  ready: {
    label: "Ready to review",
    className: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  },
  empty: {
    label: "No changes needed",
    className: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
  published: {
    label: "Merged",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  discarded: {
    label: "Discarded",
    className: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
  failed: {
    label: "Failed",
    className: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  },
};

export default function RepositoryAi() {
  const { company, repo } = useRepositoriesContext();
  const { toast } = useToast();
  const dialog = useDialog();

  const base = repo ? `/api/companies/${company.id}/repositories/${repo.slug}` : "";
  const repoId = repo?.id ?? null;
  const isRemote = repo?.origin === "remote";

  const [sessions, setSessions] = React.useState<RepositoryWorkSession[] | null>(null);
  const [candidates, setCandidates] = React.useState<
    RepositoryWorkSessionCandidatesResponse["employees"]
  >([]);
  const [employeeId, setEmployeeId] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [diffs, setDiffs] = React.useState<Record<string, RepositoryWorkSessionDiff | null>>({});
  const [actingId, setActingId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    if (!base) return;
    try {
      const [sessionRows, candidateRows] = await Promise.all([
        api.get<RepositoryWorkSessionsResponse>(`${base}/sessions`),
        api.get<RepositoryWorkSessionCandidatesResponse>(`${base}/session-candidates`),
      ]);
      setSessions(sessionRows.sessions);
      setCandidates(candidateRows.employees);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setSessions([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    setSessions(null);
    setExpandedId(null);
    setDiffs({});
    reload();
  }, [reload]);

  useLiveRefetch("repository", reload, repoId);

  const running = (sessions ?? []).some((session) => session.status === "running");

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

  React.useEffect(() => {
    if (candidates.length === 0) {
      setEmployeeId("");
      return;
    }
    setEmployeeId((current) =>
      candidates.some((candidate) => candidate.id === current) ? current : candidates[0].id,
    );
  }, [candidates]);

  const loadDiff = React.useCallback(
    async (sessionId: string) => {
      if (!base) return;
      setDiffs((current) => ({ ...current, [sessionId]: null }));
      try {
        const row = await api.get<RepositoryWorkSessionDiff>(`${base}/sessions/${sessionId}/diff`);
        setDiffs((current) => ({ ...current, [sessionId]: row }));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        setDiffs((current) => {
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
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

  const accessHref = `/c/${company.slug}/repositories/${repo.slug}/access`;

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
      setSessions((current) => [
        session,
        ...(current ?? []).filter((row) => row.id !== session.id),
      ]);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setStarting(false);
    }
  }

  async function toggle(session: RepositoryWorkSession) {
    if (expandedId === session.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(session.id);
    if (session.status !== "running" && diffs[session.id] === undefined) {
      await loadDiff(session.id);
    }
  }

  async function publish(session: RepositoryWorkSession, push: boolean) {
    const ok = await dialog.confirm({
      title: push ? "Merge and push?" : "Merge into the current branch?",
      message: push
        ? `${session.branch ?? "The branch"} is merged into this repository's checkout and pushed to the remote. A push cannot be recalled.`
        : `${session.branch ?? "The branch"} is merged into this repository's checkout. Nothing reaches the remote until someone pushes.`,
      confirmLabel: push ? "Merge and push" : "Merge",
    });
    if (!ok) return;
    setActingId(session.id);
    try {
      await api.post<RepositoryWorkSession>(`${base}/sessions/${session.id}/publish`, { push });
      await reload();
      toast(push ? "Merged and pushed" : "Merged into the checkout", "success");
    } catch (err) {
      // The push half is owner/admin only; the server's 403 explains that far
      // better than any wording this page could invent.
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setActingId(null);
    }
  }

  async function discard(session: RepositoryWorkSession) {
    const ok = await dialog.confirm({
      title: "Discard this work?",
      message:
        "The branch is dropped and the employee's changes are not merged. The request itself stays in this list.",
      confirmLabel: "Discard",
      variant: "danger",
    });
    if (!ok) return;
    setActingId(session.id);
    try {
      await api.post<RepositoryWorkSession>(`${base}/sessions/${session.id}/discard`);
      await reload();
      toast("Work discarded", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="pb-12">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
          <Sparkles size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI work
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Send an AI employee at {repo.name}. It works in its own checkout, commits to a branch,
            and reports back — then you review the diff and decide whether it lands.
          </p>
        </div>
      </div>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        {candidates.length === 0 ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                No employee can work here yet
              </div>
              <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                Grant an AI employee access to this repository first. Only employees with a grant
                get a checkout, so only they can be asked to do work in it.
              </p>
            </div>
            <Link to={accessHref} className="shrink-0">
              <Button variant="secondary">
                <Users size={15} /> Manage AI access
              </Button>
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,18rem)_1fr] sm:items-end">
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
              rows={4}
              placeholder={
                repo.kind === "documents"
                  ? "Rewrite the pricing section of docs/positioning.md to lead with the enterprise tier, and commit it."
                  : "Add a health check endpoint, cover it with a test, run the suite, and commit."
              }
              className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-400 dark:text-slate-500">
                The employee commits to its own branch. Nothing merges without your say-so.
              </span>
              <Button onClick={start} disabled={starting || !employeeId}>
                {starting ? <Spinner size={14} /> : <Sparkles size={14} />}
                {starting ? "Starting…" : "Start work"}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">
          Requests
        </h2>
        {sessions === null ? (
          <div className="flex h-32 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            Nothing has been asked for yet. The first request shows up here with its diff.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                companyId={company.id}
                session={session}
                expanded={expandedId === session.id}
                diff={diffs[session.id]}
                acting={actingId === session.id}
                allowPush={isRemote}
                onToggle={() => void toggle(session)}
                onPublish={(push) => void publish(session, push)}
                onDiscard={() => void discard(session)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SessionCard({
  companyId,
  session,
  expanded,
  diff,
  acting,
  allowPush,
  onToggle,
  onPublish,
  onDiscard,
}: {
  companyId: string;
  session: RepositoryWorkSession;
  expanded: boolean;
  /** `undefined` = never asked for, `null` = in flight. */
  diff: RepositoryWorkSessionDiff | null | undefined;
  acting: boolean;
  allowPush: boolean;
  onToggle: () => void;
  onPublish: (push: boolean) => void;
  onDiscard: () => void;
}) {
  const meta = STATUS_META[session.status];
  const employeeName = session.employee?.name ?? "Removed employee";
  const finished = session.status !== "running";

  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        <span className="mt-0.5 shrink-0">
          {expanded ? (
            <ChevronDown size={15} className="text-slate-400" />
          ) : (
            <ChevronRight size={15} className="text-slate-400" />
          )}
        </span>
        <Avatar
          name={employeeName}
          kind="ai"
          size="sm"
          src={
            session.employee
              ? employeeAvatarUrl(companyId, session.employee.id, session.employee.avatarKey)
              : null
          }
          className="mt-0.5 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {employeeName}
            </span>
            <span
              className={
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
                meta.className
              }
            >
              {session.status === "running" && <Spinner size={10} />}
              {meta.label}
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {formatRelative(session.createdAt)}
            </span>
          </span>
          <span className="mt-1 block whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-slate-300">
            {session.instruction}
          </span>
          {finished && session.branch && (
            <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch size={11} /> {session.branch}
              </span>
              {session.filesChanged > 0 && (
                <DiffStats
                  filesChanged={session.filesChanged}
                  insertions={session.insertions}
                  deletions={session.deletions}
                />
              )}
              {session.publishedBranch && (
                <span className="inline-flex items-center gap-1">
                  <Upload size={11} /> pushed
                </span>
              )}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          {session.status === "running" ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <Spinner size={14} /> The employee is working. This updates itself when the turn ends.
            </div>
          ) : (
            <>
              {session.error && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/5 dark:text-rose-300">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span className="break-words">{session.error}</span>
                </div>
              )}

              {session.reply.trim() && (
                <div className="mb-3">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    What {employeeName} reported
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-200">
                    <ChatMarkdown content={session.reply} />
                  </div>
                </div>
              )}

              {session.status === "empty" ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  The employee finished without committing anything — it read the repository and
                  found nothing to change.
                </p>
              ) : diff === undefined ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  No diff was recorded for this request.
                </p>
              ) : diff === null ? (
                <div className="flex h-24 items-center justify-center">
                  <Spinner size={18} />
                </div>
              ) : (
                <DiffView
                  patch={diff.patch}
                  truncated={diff.truncated}
                  emptyMessage="This branch has no file changes."
                />
              )}

              {session.status === "ready" && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => onPublish(false)} disabled={acting}>
                    {acting ? <Spinner size={13} /> : <GitMerge size={13} />}
                    Merge into current branch
                  </Button>
                  {allowPush && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onPublish(true)}
                      disabled={acting}
                    >
                      <Upload size={13} /> Merge and push
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={onDiscard} disabled={acting}>
                    <Trash2 size={13} /> Discard
                  </Button>
                  {!allowPush && (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      This repository is local — there is no remote to push to.
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}
