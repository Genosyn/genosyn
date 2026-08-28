import React from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  BrainCircuit,
  ClipboardCheck,
  Clock,
  Copy,
  Folder,
  Globe,
  History,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Timer,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import {
  AIModel,
  api,
  CatchUpPolicy,
  Company,
  Goal,
  MemberBrowser,
  Routine,
  RoutineFolder,
  RoutineTrigger,
  RoutineTriggerList,
  RoutineWithMeta,
  Run,
  RunLesson,
  RunLog,
  Workstream,
  WorkstreamStatus,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { useDialog } from "../components/ui/Dialog";
import { copyToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import {
  RunLiveModal,
  RunBrowserRecordingsPane,
  RunLogPane,
  RunOutcomeChip,
  RunStatusChip,
  formatDuration,
  overdueFor,
  runLogNeedsPolling,
  timeAgo,
  timeUntil,
  visibleBrowserRecordings,
} from "../components/routines/RunViews";
import { cronHuman, cronIsReadable } from "../lib/cron";
import { RoutinesContext } from "./RoutinesLayout";
import { RoutineAssistant } from "./RoutineAssistant";
import { ResourceTagPicker } from "../components/TagPicker";
import { EnabledToggle } from "./RevenueSignals";

/**
 * One routine, in full: who runs it, when, on what brain, and how every past
 * run went.
 *
 * Addressed by `:empSlug/:routineSlug` rather than a bare slug because a
 * routine slug is only unique within its employee — two employees may both
 * have a `daily-digest`.
 */

type Tab = "overview" | "brief" | "runs" | "settings";
const TABS: Array<[Tab, string]> = [
  ["overview", "Overview"],
  ["brief", "Brief"],
  ["runs", "Runs"],
  ["settings", "Settings"],
];

/**
 * Whether the Ask AI rail is open, and whether it is wound down to its 44px
 * spine. Remembered per browser rather than in the URL: opening a chat is a
 * preference about the workspace, and putting it in `?` would make every
 * shared routine link carry somebody else's panel state — and would fight
 * `?tab=` for the same history entry.
 */
const ASSISTANT_OPEN_KEY = "genosyn.routineAssistant.open";
const ASSISTANT_COLLAPSED_KEY = "genosyn.routineAssistant.collapsed";

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value ? "1" : "0");
}

export default function RoutineDetail({ company }: { company: Company }) {
  const { empSlug, routineSlug } = useParams();
  const { routines, folders, loading, refresh } = useOutletContext<RoutinesContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeRun, setActiveRun] = React.useState<Run | null>(null);
  const [aiOpen, setAiOpen] = React.useState(() => readFlag(ASSISTANT_OPEN_KEY, false));
  const [aiCollapsed, setAiCollapsed] = React.useState(() =>
    readFlag(ASSISTANT_COLLAPSED_KEY, false),
  );
  const dialog = useDialog();

  const openAssistant = React.useCallback((next: boolean) => {
    setAiOpen(next);
    writeFlag(ASSISTANT_OPEN_KEY, next);
    // Reopening a panel that was closed while wound down should give the
    // reader the panel, not the spine they can't remember collapsing.
    if (next) {
      setAiCollapsed(false);
      writeFlag(ASSISTANT_COLLAPSED_KEY, false);
    }
  }, []);

  const collapseAssistant = React.useCallback((next: boolean) => {
    setAiCollapsed(next);
    writeFlag(ASSISTANT_COLLAPSED_KEY, next);
  }, []);

  /** The conversation is actually on screen — open, and not wound down. */
  const assistantShowing = aiOpen && !aiCollapsed;

  /**
   * What the header button does. From a collapsed spine it restores the
   * conversation rather than closing the panel outright: the reader pressing
   * "Ask AI" while a spine is showing wants the chat back, and closing it
   * would take two more clicks to undo.
   */
  const toggleAssistant = React.useCallback(() => {
    if (aiOpen && aiCollapsed) {
      collapseAssistant(false);
      return;
    }
    openAssistant(!aiOpen);
  }, [aiOpen, aiCollapsed, collapseAssistant, openAssistant]);

  const routine =
    routines.find((r) => r.employee?.slug === empSlug && r.slug === routineSlug) ?? null;

  // A `?run=` deep link is a request to look at run history.
  const deepLinkedRun = searchParams.get("run");
  const tabParam = searchParams.get("tab") as Tab | null;
  const tab: Tab =
    tabParam && TABS.some(([t]) => t === tabParam) ? tabParam : deepLinkedRun ? "runs" : "overview";

  function setTab(next: Tab) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "overview") p.delete("tab");
        else p.set("tab", next);
        // A stale `?run=` would drag us straight back to the runs tab, since a
        // bare `run` param reads as "show me run history".
        if (next !== "runs") p.delete("run");
        return p;
      },
      { replace: true },
    );
  }

  // Open one run in the runs tab. Both params move together: `tab` alone would
  // land on the newest run, `run` alone would rely on the implicit tab switch.
  function openRun(runId: string) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("tab", "runs");
        p.set("run", runId);
        return p;
      },
      { replace: true },
    );
  }

  async function triggerRun() {
    if (!routine) return;
    try {
      const run = await api.post<Run>(`/api/companies/${company.id}/routines/${routine.id}/run`);
      setActiveRun(run);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the run" });
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  if (!routine) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Breadcrumbs items={[{ label: "Routines", to: `/c/${company.slug}/routines` }]} />
        <div className="mt-4">
          <EmptyState
            title="Routine not found"
            description="It may have been deleted, or renamed to a different address."
            action={
              <Link to={`/c/${company.slug}/routines`}>
                <Button variant="secondary">Back to routines</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const emp = routine.employee;
  const brokenSchedule = routine.enabled && routine.nextRunAt === null;
  // With the rail docked, the page has roughly a phone's width to play with.
  // Two-column tab layouts stop being two columns at that point.
  const compact = assistantShowing;

  return (
    // A flex row so the Ask AI rail can dock beside the routine, the same
    // shape the mail thread uses. `relative` anchors the rail's narrow-window
    // takeover; the left column takes the page's scroll off `<main>` so the
    // rail scrolls its own conversation instead of riding the page down.
    <div className="relative flex h-full min-h-0 w-full">
      <div className="page-shell min-w-0 flex-1 overflow-y-auto p-6">
        <Breadcrumbs
          items={[
            { label: "Routines", to: `/c/${company.slug}/routines` },
            ...(emp
              ? [{ label: emp.name, to: `/c/${company.slug}/routines?employee=${emp.slug}` }]
              : []),
            { label: routine.name },
          ]}
        />

        <div className="mb-5 mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {routine.name}
              </h1>
              {!routine.enabled && (
                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <Pause size={10} /> paused
                </span>
              )}
              {routine.lastRun && <RunStatusChip status={routine.lastRun.status} size="xs" />}
              {routine.lastRun?.outcomeVerdict && (
                <RunOutcomeChip verdict={routine.lastRun.outcomeVerdict} size="xs" />
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              <span title={routine.cronExpr}>{cronHuman(routine.cronExpr)}</span>
              {routine.enabled && routine.nextRunAt && (
                <>
                  <span aria-hidden="true">·</span>
                  {overdueFor(routine.nextRunAt) ? (
                    <span
                      className="text-amber-600 dark:text-amber-400"
                      title={new Date(routine.nextRunAt).toLocaleString()}
                    >
                      overdue by {overdueFor(routine.nextRunAt)}
                    </span>
                  ) : (
                    <span title={new Date(routine.nextRunAt).toLocaleString()}>
                      next {timeUntil(routine.nextRunAt)}
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="mt-3 max-w-lg">
              <ResourceTagPicker
                companyId={company.id}
                resourceType="routine"
                resourceId={routine.id}
                value={routine.tags ?? []}
                onSaved={refresh}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => toggleAssistant()}
              // "Showing" means the conversation is on screen. A rail wound
              // down to its spine is open but not showing, so announcing it as
              // pressed would contradict what the reader can see.
              aria-pressed={assistantShowing}
            >
              <Sparkles size={14} /> Ask AI
            </Button>
            <Button onClick={triggerRun}>
              <Play size={14} /> Run now
            </Button>
          </div>
        </div>

        {brokenSchedule && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">This routine never fires.</div>
              <div className="text-xs">
                It&apos;s enabled, but no next run could be computed from{" "}
                <code className="font-mono">{routine.cronExpr}</code>. Edit the schedule under
                Settings, or run it manually.
              </div>
            </div>
          </div>
        )}

        <div className="mb-5 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition " +
                (tab === key
                  ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
              }
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <OverviewTab
            folders={folders}
            company={company}
            routine={routine}
            compact={compact}
            onSeeRuns={() => setTab("runs")}
            onOpenRun={openRun}
          />
        )}
        {tab === "brief" && <BriefTab company={company} routine={routine} />}
        {tab === "runs" && (
          <RunsTab
            company={company}
            routine={routine}
            compact={compact}
            initialRunId={deepLinkedRun}
            onRetry={triggerRun}
          />
        )}
        {tab === "settings" && (
          <SettingsTab company={company} routine={routine} folders={folders} onSaved={refresh} />
        )}

        {activeRun && (
          <RunLiveModal
            key={activeRun.id}
            company={company}
            routine={routine}
            run={activeRun}
            onRetry={triggerRun}
            onClose={() => {
              setActiveRun(null);
              refresh();
            }}
          />
        )}
      </div>

      {aiOpen && (
        <RoutineAssistant
          company={company}
          routine={routine}
          collapsed={aiCollapsed}
          onCollapsedChange={collapseAssistant}
          onClose={() => openAssistant(false)}
        />
      )}
    </div>
  );
}

// ───────────────────────────── Overview ─────────────────────────────────

function OverviewTab({
  company,
  routine,
  folders,
  compact,
  onSeeRuns,
  onOpenRun,
}: {
  company: Company;
  routine: RoutineWithMeta;
  folders: RoutineFolder[];
  /** The Ask AI rail is docked, so there is no room for two columns. */
  compact: boolean;
  onSeeRuns: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [runs, setRuns] = React.useState<Run[] | null>(null);
  const [model, setModel] = React.useState<AIModel | null | undefined>(undefined);
  const emp = routine.employee;
  const folder = routine.folderId ? (folders.find((f) => f.id === routine.folderId) ?? null) : null;

  React.useEffect(() => {
    api
      .get<Run[]>(`/api/companies/${company.id}/routines/${routine.id}/runs`)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [company.id, routine.id]);

  // Resolve what "this routine's brain" actually means right now — the pin if
  // it holds, otherwise whatever the employee has active (which is what the
  // runner would fall back to).
  React.useEffect(() => {
    if (!emp) return;
    api
      .get<AIModel[]>(`/api/companies/${company.id}/employees/${emp.id}/models`)
      .then((list) => {
        const pinned = routine.modelId ? list.find((m) => m.id === routine.modelId) : null;
        setModel(pinned ?? list.find((m) => m.isActive) ?? null);
      })
      .catch(() => setModel(null));
  }, [company.id, emp, routine.modelId]);

  const pinHolds = !!routine.modelId && model?.id === routine.modelId;
  const recent = (runs ?? []).slice(0, 5);

  return (
    <div className={clsx("grid gap-4", !compact && "md:grid-cols-2")}>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <SectionLabel>Assigned to</SectionLabel>
          {emp ? (
            <Link
              to={`/c/${company.slug}/employees/${emp.slug}`}
              className="group flex items-center gap-3"
            >
              <Avatar
                name={emp.name}
                src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
                kind="ai"
                size="lg"
              />
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900 group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-400">
                  {emp.name}
                </div>
                <div className="truncate text-sm text-slate-500 dark:text-slate-400">
                  {emp.role || "AI employee"}
                </div>
              </div>
            </Link>
          ) : (
            <div className="text-sm text-slate-400 dark:text-slate-500">
              The employee that owned this routine is gone.
            </div>
          )}
          <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
            <Row icon={<BrainCircuit size={14} />} label="Runs on">
              {model === undefined ? (
                <span className="text-slate-400">…</span>
              ) : model === null ? (
                <span className="text-amber-600 dark:text-amber-400">
                  No model connected — runs are skipped
                </span>
              ) : (
                <span>
                  {model.provider} · {model.model}{" "}
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {pinHolds ? "(pinned)" : "(employee's active model)"}
                  </span>
                </span>
              )}
            </Row>
            <Row icon={<Folder size={14} />} label="Filed in">
              {folder ? (
                <Link
                  to={`/c/${company.slug}/routines?folder=${encodeURIComponent(folder.slug)}`}
                  className="hover:text-indigo-600 dark:hover:text-indigo-400"
                >
                  {folder.path}
                </Link>
              ) : (
                <span className="text-slate-400 dark:text-slate-500">Unfiled</span>
              )}
            </Row>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <SectionLabel>Schedule</SectionLabel>
          <Row icon={<Clock size={14} />} label="Fires">
            <span title={routine.cronExpr}>{cronHuman(routine.cronExpr)}</span>
          </Row>
          <Row icon={<Clock size={14} />} label="Next run">
            {!routine.enabled ? (
              <span className="text-slate-400 dark:text-slate-500">Paused</span>
            ) : routine.nextRunAt && overdueFor(routine.nextRunAt) ? (
              <span
                className="text-amber-600 dark:text-amber-400"
                title={new Date(routine.nextRunAt).toLocaleString()}
              >
                Overdue by {overdueFor(routine.nextRunAt)}
              </span>
            ) : routine.nextRunAt ? (
              <span title={new Date(routine.nextRunAt).toLocaleString()}>
                {new Date(routine.nextRunAt).toLocaleString()} ({timeUntil(routine.nextRunAt)})
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">Never</span>
            )}
          </Row>
          <Row icon={<Clock size={14} />} label="Last run">
            {routine.lastRunAt ? (
              <span title={new Date(routine.lastRunAt).toLocaleString()}>
                {timeAgo(routine.lastRunAt)}
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">Never</span>
            )}
          </Row>
          <Row icon={<Timer size={14} />} label="Timeout">
            {formatTimeout(routine.timeoutSec)}
          </Row>
          <Row icon={<ShieldCheck size={14} />} label="Approval">
            {routine.requiresApproval
              ? "Each scheduled run waits for a human"
              : "Runs without asking"}
          </Row>
          <Row icon={<ClipboardCheck size={14} />} label="Outcome check">
            {routine.acceptanceCriteria?.trim()
              ? "Completed runs are graded against acceptance criteria"
              : "Off — no acceptance criteria set"}
          </Row>
          <Row icon={<Globe size={14} />} label="Browser">
            {routine.browserEnabledOverride === true
              ? "Forced on for this routine"
              : routine.browserEnabledOverride === false
                ? "Forced off for this routine"
                : "Inherits the employee setting"}
            {routine.memberBrowserId && " · runs in a connected browser"}
          </Row>
          <Row icon={<History size={14} />} label="Catch-up">
            {routine.catchUpPolicy === "skip"
              ? "Skips a catch-up that is already late"
              : "Fires once after downtime"}
          </Row>
          <Row icon={<RefreshCw size={14} />} label="Retries">
            {(routine.maxAttempts ?? 1) <= 1
              ? routine.enabled && !routine.requiresApproval
                ? "Interrupted scheduled Runs retry once after 1h"
                : "Automatic recovery is off while paused or approval-gated"
              : `Up to ${routine.maxAttempts} attempts, from ${formatTimeout(
                  routine.retryBackoffSec ?? 60,
                )}`}
          </Row>
          <Row icon={<Webhook size={14} />} label="Webhook">
            {routine.webhookEnabled ? "Enabled" : "Off"}
          </Row>
        </CardBody>
      </Card>

      <LessonsCard company={company} routine={routine} compact={compact} />

      <WorkstreamCard company={company} routine={routine} compact={compact} />

      <Card className={compact ? undefined : "md:col-span-2"}>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <SectionLabel>Recent runs</SectionLabel>
            {(runs?.length ?? 0) > 0 && (
              <button
                onClick={onSeeRuns}
                className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                See all
              </button>
            )}
          </div>
          {runs === null ? (
            <Spinner />
          ) : recent.length === 0 ? (
            <div className="py-4 text-center text-sm text-slate-400 dark:text-slate-500">
              This routine hasn&apos;t run yet.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recent.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => onOpenRun(run.id)}
                    className="flex w-full items-center gap-3 rounded px-1 py-2 text-left text-sm transition hover:bg-slate-50 dark:hover:bg-slate-900"
                  >
                    <RunStatusChip status={run.status} size="xs" />
                    {run.outcomeVerdict && (
                      <RunOutcomeChip
                        verdict={run.outcomeVerdict}
                        note={run.outcomeNote}
                        size="xs"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>
                    {run.exitCode !== null && (
                      <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                        exit {run.exitCode}
                      </span>
                    )}
                    <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                      {formatDuration(run.startedAt, run.finishedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Lessons — the takeaways graded Runs left behind (M52). The runner folds
 * every undismissed lesson into the routine's future prompts, so an admin
 * dismissing one here is telling future runs to stop hearing it. The section
 * vanishes entirely while the routine has no lessons: an empty queue is not
 * news.
 */
function LessonsCard({
  company,
  routine,
  compact,
}: {
  company: Company;
  routine: RoutineWithMeta;
  compact: boolean;
}) {
  const [lessons, setLessons] = React.useState<RunLesson[] | null>(null);
  const dialog = useDialog();
  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(() => {
    api
      .get<RunLesson[]>(`/api/companies/${company.id}/run-lessons/routine/${routine.id}`)
      .then(setLessons)
      .catch(() => setLessons([]));
  }, [company.id, routine.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Lessons ride the routine's own live-sync kind, scoped like the runs list:
  // a graded run writing a new lesson lands here without a manual refresh.
  useLiveRefetch("routine", reload, routine.id);

  async function dismiss(lesson: RunLesson) {
    try {
      await api.post(`/api/companies/${company.id}/run-lessons/${lesson.id}/dismiss`, {});
      reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t dismiss the lesson" });
    }
  }

  if (!lessons || lessons.length === 0) return null;

  return (
    <Card className={compact ? undefined : "md:col-span-2"}>
      <CardBody className="flex flex-col gap-3">
        <SectionLabel>Lessons</SectionLabel>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {lessons.map((lesson) => (
            <li key={lesson.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div
                  className={clsx(
                    "text-sm",
                    lesson.dismissedAt
                      ? "text-slate-400 dark:text-slate-500"
                      : "text-slate-800 dark:text-slate-200",
                  )}
                >
                  {lesson.advice}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  because: {lesson.cause}
                </div>
              </div>
              <span
                className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500"
                title={new Date(lesson.createdAt).toLocaleString()}
              >
                {new Date(lesson.createdAt).toLocaleDateString()}
              </span>
              {lesson.dismissedAt ? (
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  Dismissed
                </span>
              ) : canManage ? (
                <Button variant="ghost" size="sm" onClick={() => void dismiss(lesson)}>
                  Dismiss
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Workstream — the persistent state document for work this routine's Runs
 * carry across sessions (M54). Only an ACTIVE workstream is news on the
 * routine page — the card vanishes when there is none, like Lessons. Closing
 * (admin) records done/abandoned plus a reason; the employee reads both.
 */
function WorkstreamCard({
  company,
  routine,
  compact,
}: {
  company: Company;
  routine: RoutineWithMeta;
  compact: boolean;
}) {
  const [workstreams, setWorkstreams] = React.useState<Workstream[] | null>(null);
  const [closing, setClosing] = React.useState(false);
  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(() => {
    api
      .get<Workstream[]>(`/api/companies/${company.id}/workstreams`)
      .then(setWorkstreams)
      .catch(() => setWorkstreams([]));
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // A run rewriting the state document, or another admin closing the stream,
  // lands here without a manual refresh.
  useLiveRefetch("workstream", reload);

  // The list endpoint filters by employee, not routine — narrow client-side.
  const active =
    (workstreams ?? []).find((w) => w.routineId === routine.id && w.status === "active") ?? null;

  if (!active) return null;

  return (
    <Card className={compact ? undefined : "md:col-span-2"}>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Workstream</SectionLabel>
          {canManage && (
            <Button variant="ghost" size="sm" onClick={() => setClosing(true)}>
              Close
            </Button>
          )}
        </div>
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {active.title}
          </div>
          {active.objective && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {active.objective}
            </div>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 font-mono text-xs leading-5 text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
          {active.stateDoc.trim() || "The employee hasn't written the state document yet."}
        </div>
        <div className="text-xs text-slate-400 dark:text-slate-500">
          last updated {new Date(active.updatedAt).toLocaleDateString()}
        </div>
        {closing && (
          <CloseWorkstreamModal
            company={company}
            workstream={active}
            onClose={() => setClosing(false)}
            onClosed={() => {
              setClosing(false);
              reload();
            }}
          />
        )}
      </CardBody>
    </Card>
  );
}

function CloseWorkstreamModal({
  company,
  workstream,
  onClose,
  onClosed,
}: {
  company: Company;
  workstream: Workstream;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [status, setStatus] = React.useState<Exclude<WorkstreamStatus, "active">>("done");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Give a reason — the employee reads it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/workstreams/${workstream.id}/close`, {
        status,
        reason: trimmed,
      });
      onClosed();
    } catch (err) {
      setError(errorMessage(err, "Could not close the workstream"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Close "${workstream.title}"?`}
      description="The state document is kept for the record; future runs stop carrying it."
      onSubmit={save}
      footer={
        <>
          <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Closing…" : "Close workstream"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError message={error} />
        <div className="flex flex-col gap-1.5">
          {(
            [
              ["done", "Done — the objective was reached"],
              ["abandoned", "Abandoned — stop pursuing it"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
            >
              <input
                type="radio"
                name="workstream-close-status"
                checked={status === value}
                onChange={() => setStatus(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <Textarea
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-h-[60px]"
          placeholder="Why it's closing — the employee reads this."
        />
      </div>
    </Modal>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
      {children}
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500">{icon}</span>
      <span className="w-24 shrink-0 text-slate-500 dark:text-slate-400">{label}</span>
      <span className="min-w-0 flex-1 text-slate-800 dark:text-slate-200">{children}</span>
    </div>
  );
}

function formatTimeout(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/**
 * The upper edge of each retry's jitter band, so the operator sees what
 * "backoff 60s, 3 attempts" actually costs in wall-clock before saving. The
 * real delay is uniform in [0, this), and the server caps it at 6 hours.
 */
function backoffPreview(baseSec: number, attempts: number): string {
  const steps: string[] = [];
  for (let i = 0; i < Math.max(0, attempts - 1) && i < 4; i += 1) {
    steps.push(formatTimeout(Math.min(6 * 3600, baseSec * 2 ** i)));
  }
  return steps.length ? `up to ${steps.join(", then ")}` : "no retries";
}

// ─────────────────────────────── Brief ──────────────────────────────────

/**
 * The markdown brief the runner folds into the prompt every time the routine
 * fires. Round-trips against `Routine.body` via `/routines/:rid/readme`.
 */
function BriefTab({ company, routine }: { company: Company; routine: RoutineWithMeta }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/routines/${routine.id}/readme`)
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      })
      .catch((err: unknown) => setLoadError(errorMessage(err, "Could not load the brief")));
  }, [company.id, routine.id]);

  async function save() {
    if (content === null) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/companies/${company.id}/routines/${routine.id}/readme`, { content });
      setSaved(content);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <FormError message={loadError} />;
  if (content === null) return <Spinner />;
  const dirty = content !== saved;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          What this employee should actually do each time the routine fires. Folded into the prompt
          on every run.
        </p>
        <MarkdownEditor value={content} onChange={setContent} rows={18} />
        <FormError message={error} />
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save brief"}
          </Button>
          {dirty && (
            <span className="text-xs text-slate-400 dark:text-slate-500">Unsaved changes</span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ──────────────────────────────── Runs ──────────────────────────────────

/**
 * Full run history. Left rail lists recent runs newest-first; picking one
 * loads its captured log. The server keeps the 50 most recent and caps each
 * log at 256KB.
 */
function RunsTab({
  company,
  routine,
  compact,
  initialRunId,
  onRetry,
}: {
  company: Company;
  routine: RoutineWithMeta;
  /** The Ask AI rail is docked, so the run list stacks above the log. */
  compact: boolean;
  initialRunId: string | null;
  onRetry: () => void;
}) {
  const [runs, setRuns] = React.useState<Run[] | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<RunLog | null>(null);
  const [loadingLog, setLoadingLog] = React.useState(false);
  const [logLoadError, setLogLoadError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const dialog = useDialog();
  const recordings = visibleBrowserRecordings(log?.browserRecordings);

  const loadRuns = React.useCallback(async () => {
    try {
      const list = await api.get<Run[]>(`/api/companies/${company.id}/routines/${routine.id}/runs`);
      setRuns(list);
      setLoadError(null);
      setActiveId((current) => {
        // Keep the run the human is looking at selected across a live refetch;
        // only fall back to the deep-linked or newest run on first load.
        if (current && list.some((r) => r.id === current)) return current;
        if (list.length === 0) return null;
        return initialRunId && list.some((r) => r.id === initialRunId) ? initialRunId : list[0].id;
      });
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the runs"));
      setRuns([]);
    }
  }, [company.id, routine.id, initialRunId]);

  React.useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // A run flipping running → done, or a fresh run appearing, is the canonical
  // "an AI employee did something" moment — reflect it without a refresh.
  useLiveRefetch("run", loadRuns, routine.id);

  React.useEffect(() => {
    if (!activeId) {
      setLog(null);
      setLogLoadError(null);
      return;
    }
    setLoadingLog(true);
    setLog(null);
    setLogLoadError(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;
    async function loadLog() {
      try {
        const l = await api.get<RunLog>(`/api/companies/${company.id}/runs/${activeId}/log`);
        if (cancelled) return;
        consecutiveErrors = 0;
        setLog(l);
        setLogLoadError(null);
        if (runLogNeedsPolling(l)) timer = setTimeout(loadLog, 1200);
      } catch (err) {
        if (cancelled) return;
        consecutiveErrors += 1;
        setLogLoadError(`${errorMessage(err, "Couldn’t load the log.")} Retrying…`);
        const retryDelay = Math.min(10_000, 2500 * 2 ** Math.min(consecutiveErrors - 1, 2));
        timer = setTimeout(loadLog, retryDelay);
      } finally {
        if (!cancelled) setLoadingLog(false);
      }
    }
    void loadLog();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, activeId]);

  if (loadError) return <FormError message={loadError} />;
  if (runs === null) return <Spinner />;
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="Hit Run now to trigger this routine, or wait for its schedule to fire."
        action={
          <Button onClick={onRetry}>
            <Play size={14} /> Run now
          </Button>
        }
      />
    );
  }

  const activeRun = runs.find((r) => r.id === activeId) ?? null;
  // The Runs list is live-refetched; the selected log is a one-shot snapshot
  // once terminal. Let the list own queue state so a dispatched retry cannot
  // leave behind a stale Cancel action.
  const pendingRetryAt = activeRun?.retryAt ?? null;

  async function cancelActiveRetry() {
    if (!activeRun || !pendingRetryAt) return;
    try {
      await api.post(`/api/companies/${company.id}/runs/${activeRun.id}/cancel-retry`, {});
      setRuns(
        (current) =>
          current?.map((run) => (run.id === activeRun.id ? { ...run, retryAt: null } : run)) ??
          null,
      );
      setLog((current) => (current ? { ...current, retryAt: null } : current));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t cancel the retry" });
      await loadRuns();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={clsx("flex flex-col gap-3", !compact && "md:flex-row")}
        style={{ minHeight: 460 }}
      >
        <aside
          className={clsx(
            "max-h-48 w-full shrink-0 overflow-y-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950",
            !compact && "md:max-h-none md:w-64",
          )}
        >
          <ul className="flex flex-col">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setActiveId(r.id)}
                  className={
                    "flex w-full flex-col gap-0.5 border-b border-slate-100 px-3 py-2 text-left text-xs dark:border-slate-800 " +
                    (r.id === activeId
                      ? "bg-indigo-50 dark:bg-indigo-500/10"
                      : "hover:bg-slate-50 dark:hover:bg-slate-900")
                  }
                >
                  <div className="flex items-center gap-2">
                    <RunStatusChip status={r.status} size="xs" />
                    {r.outcomeVerdict && (
                      <RunOutcomeChip verdict={r.outcomeVerdict} note={r.outcomeNote} size="xs" />
                    )}
                    {r.exitCode !== null && (
                      <span className="text-[10px] text-slate-400 dark:text-slate-500">
                        exit {r.exitCode}
                      </span>
                    )}
                    {(r.attempt ?? 1) > 1 && (
                      <span className="text-[10px] text-slate-400 dark:text-slate-500">
                        attempt {r.attempt}
                      </span>
                    )}
                    {r.retryAt && (
                      <span className="text-[10px] text-slate-400 dark:text-slate-500">
                        retry {timeUntil(r.retryAt)}
                      </span>
                    )}
                    {(r.missedSlots ?? 0) > 0 && (
                      <span
                        className="text-[10px] text-amber-600 dark:text-amber-400"
                        title="Scheduled occurrences missed while the server was unavailable"
                      >
                        +{r.missedSlots} missed
                      </span>
                    )}
                  </div>
                  <div className="text-slate-700 dark:text-slate-200">
                    {new Date(r.startedAt).toLocaleString()}
                  </div>
                  <div className="text-slate-400 dark:text-slate-500">
                    {formatDuration(r.startedAt, r.finishedAt)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div
          className={
            "grid min-w-0 flex-1 gap-3 " +
            (recordings.length > 0 && !compact ? "xl:grid-cols-2" : "")
          }
        >
          <RunLogPane
            log={log}
            loading={loadingLog}
            placeholder={logLoadError ?? "(empty log)"}
            className="h-full max-h-[60vh] min-h-[400px]"
          />
          {recordings.length > 0 && activeId && (
            <RunBrowserRecordingsPane
              companyId={company.id}
              runId={activeId}
              recordings={recordings}
              className="min-h-[400px] max-h-[60vh]"
            />
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {pendingRetryAt
            ? `Automatic recovery is scheduled ${timeUntil(pendingRetryAt)}. Cancel it before running manually to avoid two Runs.`
            : activeRun?.status === "interrupted"
              ? "The log above shows activity captured before the server stopped; anything after its final line is unknown. Run it again only if repeating the work is safe."
              : activeRun && (activeRun.status === "failed" || activeRun.status === "timeout")
                ? "This run didn't finish cleanly. Retry to run the routine again now."
                : "Showing the 50 most recent runs."}
        </div>
        <div className="flex shrink-0 gap-2">
          {pendingRetryAt ? (
            <Button variant="secondary" onClick={cancelActiveRetry}>
              <Ban size={14} /> Cancel retry
            </Button>
          ) : (
            <Button variant="secondary" onClick={onRetry}>
              <Play size={14} /> Run now
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────── Settings ────────────────────────────────

function SettingsTab({
  company,
  routine,
  folders,
  onSaved,
}: {
  company: Company;
  routine: RoutineWithMeta;
  folders: RoutineFolder[];
  onSaved: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const dialog = useDialog();
  const emp = routine.employee;

  const [name, setName] = React.useState(routine.name);
  const [cronExpr, setCronExpr] = React.useState(routine.cronExpr);
  const [enabled, setEnabled] = React.useState(routine.enabled);
  // "" is the unfiled choice — the routine sits in no folder at all.
  const [folderId, setFolderId] = React.useState(routine.folderId ?? "");

  // Re-seed when the routine reloads (a bulk move from the list, another
  // Member filing it, the folder being deleted underneath us). Without this the
  // picker held whatever it was mounted with, and saving an unrelated setting
  // re-filed the routine — or 400'd on a folder id that no longer exists.
  React.useEffect(() => {
    const current = routine.folderId ?? "";
    setFolderId(current && !folders.some((f) => f.id === current) ? "" : current);
  }, [routine.id, routine.folderId, folders]);
  // "" is the unlinked choice — the routine serves no goal.
  const [goalId, setGoalId] = React.useState(routine.goalId ?? "");
  const [goals, setGoals] = React.useState<Goal[]>([]);
  // Same re-seed discipline as the folder picker: another Member linking the
  // routine, or the goal being deleted underneath us (which unlinks it
  // server-side), must not be undone by saving an unrelated setting.
  React.useEffect(() => {
    setGoalId(routine.goalId ?? "");
  }, [routine.id, routine.goalId]);
  const [timeoutSec, setTimeoutSec] = React.useState(routine.timeoutSec ?? 3600);
  const [requiresApproval, setRequiresApproval] = React.useState(routine.requiresApproval ?? false);
  // "" is the inherit choice — the routine follows the employee's active model.
  const [modelId, setModelId] = React.useState(routine.modelId ?? "");
  const [models, setModels] = React.useState<AIModel[] | null>(null);
  // Tri-state: "inherit" reads as null, "on"/"off" force a boolean override.
  const [catchUpPolicy, setCatchUpPolicy] = React.useState<CatchUpPolicy>(
    routine.catchUpPolicy ?? "once",
  );
  const [maxAttempts, setMaxAttempts] = React.useState(routine.maxAttempts ?? 1);
  const [retryBackoffSec, setRetryBackoffSec] = React.useState(routine.retryBackoffSec ?? 60);
  const [retryOnTimeout, setRetryOnTimeout] = React.useState(routine.retryOnTimeout ?? false);
  const [acceptanceCriteria, setAcceptanceCriteria] = React.useState(
    routine.acceptanceCriteria ?? "",
  );
  const [browserOverride, setBrowserOverride] = React.useState<"inherit" | "on" | "off">(
    routine.browserEnabledOverride === true
      ? "on"
      : routine.browserEnabledOverride === false
        ? "off"
        : "inherit",
  );
  const [memberBrowserId, setMemberBrowserId] = React.useState<string | null>(
    routine.memberBrowserId ?? null,
  );
  const [memberBrowsers, setMemberBrowsers] = React.useState<MemberBrowser[]>([]);
  const [webhookEnabled, setWebhookEnabled] = React.useState(routine.webhookEnabled);
  const [webhookToken, setWebhookToken] = React.useState(routine.webhookToken);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [webhookError, setWebhookError] = React.useState<string | null>(null);
  const [webhookNotice, setWebhookNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!emp) return;
    api
      .get<AIModel[]>(`/api/companies/${company.id}/employees/${emp.id}/models`)
      .then((list) => {
        setModels(list);
        // A pin can dangle if the model was removed out from under us. Show
        // inherit, which is what the runner would fall back to anyway.
        setModelId((cur) => (cur && !list.some((m) => m.id === cur) ? "" : cur));
      })
      .catch(() => setModels([]));
  }, [company.id, emp]);

  React.useEffect(() => {
    api
      .get<Goal[]>(`/api/companies/${company.id}/goals`)
      .then((list) => {
        setGoals(list);
        // A link can dangle if the goal was deleted out from under us. Show
        // "None", which is what the server holds by then anyway.
        setGoalId((cur) => (cur && !list.some((g) => g.id === cur) ? "" : cur));
      })
      .catch(() => setGoals([]));
  }, [company.id]);

  React.useEffect(() => {
    if (!emp) return;
    api
      .get<MemberBrowser[]>(`/api/companies/${company.id}/member-browsers/for-employee/${emp.id}`)
      // Keep unavailable browsers in the picker so a legacy Routine does not
      // render as if it silently switched back to Genosyn's browser. They stay
      // disabled until their owner re-confirms unattended recording consent.
      .then(setMemberBrowsers)
      .catch(() => setMemberBrowsers([]));
  }, [company.id, emp]);

  async function toggleWebhook(next: boolean) {
    setWebhookError(null);
    setWebhookNotice(null);
    try {
      const updated = await api.post<Routine>(
        `/api/companies/${company.id}/routines/${routine.id}/webhook`,
        { enabled: next },
      );
      setWebhookEnabled(updated.webhookEnabled);
      setWebhookToken(updated.webhookToken);
    } catch (err) {
      setWebhookError(errorMessage(err));
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/companies/${company.id}/routines/${routine.id}`, {
        name,
        cronExpr,
        enabled,
        timeoutSec,
        requiresApproval,
        folderId: folderId || null,
        goalId: goalId || null,
        modelId: modelId || null,
        browserEnabledOverride:
          browserOverride === "on" ? true : browserOverride === "off" ? false : null,
        memberBrowserId,
        catchUpPolicy,
        maxAttempts,
        retryBackoffSec,
        retryOnTimeout,
        acceptanceCriteria,
      });
      // The slug is stable across renames, so the address survives — but the
      // list behind it has to reload before the header shows the new name.
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // The server computes `isActive` live, so this is the brain "Inherit" means.
  const activeModel = (models ?? []).find((m) => m.isActive) ?? null;
  const pinnedModelMissing =
    models !== null && !!routine.modelId && !models.some((m) => m.id === routine.modelId);
  const webhookUrl =
    webhookEnabled && webhookToken
      ? `${window.location.origin}/api/webhooks/r/${routine.id}/${webhookToken}`
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <SectionLabel>Basics</SectionLabel>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />

          <div className="flex flex-col gap-1">
            <Select label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">Unfiled</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </Select>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {folders.length === 0
                ? "No folders yet — create one from the Routines sidebar."
                : "Where this routine lives. Use tags for what it’s about; a routine has one folder and any number of tags."}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Select label="Goal" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              <option value="">None</option>
              {[...goals]
                .sort(
                  (a, b) =>
                    Number(a.status !== "active") - Number(b.status !== "active"),
                )
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.status === "active" ? g.title : `${g.title} (${g.status})`}
                  </option>
                ))}
            </Select>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {goals.length === 0
                ? "No goals yet — create one on the Goals page."
                : "The objective this routine’s work serves."}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Input
              label="Schedule"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              className="font-mono"
            />
            <div
              className={
                "text-xs " +
                (cronIsReadable(cronExpr)
                  ? "text-slate-500 dark:text-slate-400"
                  : "text-amber-600 dark:text-amber-400")
              }
            >
              {cronIsReadable(cronExpr)
                ? cronHuman(cronExpr)
                : "Not a schedule we can read — check the expression."}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Input
              label="Timeout (seconds)"
              type="number"
              min={10}
              max={21600}
              value={String(timeoutSec)}
              onChange={(e) => setTimeoutSec(Math.max(10, Number(e.target.value) || 3600))}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Hard kill after this long. The run is marked <code>timeout</code>.
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={requiresApproval}
                onChange={(e) => setRequiresApproval(e.target.checked)}
              />
              Require approval before each scheduled run
            </label>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Manual &quot;Run now&quot; still runs immediately — a human is already in the loop.
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <SectionLabel>Outcome check</SectionLabel>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Acceptance criteria
            </label>
            <textarea
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder={
                'What must be true for a run to count — e.g. "The digest was posted to #general and covers every failed run since the last digest."'
              }
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Written in plain language. The criteria ride along in every run&apos;s brief, and
              after a completed run a restricted checker grades the transcript against them — the
              verdict shows on the run as <code>achieved</code> / <code>unclear</code> /{" "}
              <code>off goal</code>, and an off-goal run notifies the company&apos;s owners and
              admins, plus this employee&apos;s manager. Leave empty to switch the check off.
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <SectionLabel>Execution</SectionLabel>
          <div className="flex flex-col gap-1.5">
            <Select
              label="Model"
              value={modelId}
              disabled={models === null}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">
                {activeModel
                  ? `Inherit — ${activeModel.provider} · ${activeModel.model}`
                  : "Inherit the employee's active model"}
              </option>
              {(models ?? [])
                .filter((m) => m.id !== activeModel?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.provider} · {m.model}
                  </option>
                ))}
            </Select>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {pinnedModelMissing
                ? "The model this routine was pinned to is gone. It now inherits the employee's active model."
                : "Inherit follows whichever model is active for the employee. Pinning applies to this routine's Runs only — employee Chat has its own per-message model picker."}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Browser access
            </span>
            <div className="flex gap-1 rounded-md border border-slate-200 p-0.5 text-xs dark:border-slate-700">
              {(
                [
                  ["inherit", "Inherit"],
                  ["on", "Force on"],
                  ["off", "Force off"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setBrowserOverride(value)}
                  className={
                    "flex-1 rounded px-2 py-1 transition " +
                    (browserOverride === value
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Inherit uses the employee&apos;s Browser access setting. An override applies only to
              this routine&apos;s runs.
            </div>
          </div>

          {memberBrowsers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Which browser
              </span>
              <Select
                aria-label="Browser this routine runs in"
                value={memberBrowserId ?? ""}
                onChange={(e) => setMemberBrowserId(e.target.value || null)}
              >
                <option value="">Genosyn&apos;s browser</option>
                {memberBrowsers.map((browser) => (
                  <option key={browser.id} value={browser.id} disabled={!browser.allowUnattended}>
                    {browser.name}
                    {browser.routineRecordingConsentRequired
                      ? " (needs re-confirmation)"
                      : !browser.allowUnattended
                        ? " (unavailable for Routines)"
                        : ""}
                  </option>
                ))}
              </Select>
              {memberBrowserId &&
                memberBrowsers.some(
                  (browser) =>
                    browser.id === memberBrowserId && browser.routineRecordingConsentRequired,
                ) && (
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    Its owner needs to turn scheduled Routine use on again under the new recording
                    notice in Settings → Browsers.
                  </div>
                )}
              {memberBrowserId &&
                memberBrowsers.some(
                  (browser) =>
                    browser.id === memberBrowserId &&
                    !browser.allowUnattended &&
                    !browser.routineRecordingConsentRequired,
                ) && (
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    This browser is not available to scheduled Routines. Its owner can enable it in
                    Settings → Browsers.
                  </div>
                )}
              <div className="text-xs text-slate-500 dark:text-slate-400">
                A routine fires on a schedule with nobody watching. If you point it at a browser on
                your own computer and that computer is asleep when the routine runs, the run fails
                rather than quietly using a different browser.
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <SectionLabel>Reliability</SectionLabel>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              After downtime
            </span>
            <div className="flex gap-1 rounded-md border border-slate-200 p-0.5 text-xs dark:border-slate-700">
              {(
                [
                  ["once", "Run once"],
                  ["skip", "Skip"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCatchUpPolicy(value)}
                  className={
                    "flex-1 rounded px-2 py-1 transition " +
                    (catchUpPolicy === value
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              A routine fires once after an outage, never once per missed slot. Skip suppresses that
              catch-up run when the slot is already more than a minute late — for work that&apos;s
              only useful on time.
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Input
              label="Attempts"
              type="number"
              min={1}
              max={5}
              value={String(maxAttempts)}
              onChange={(e) =>
                setMaxAttempts(Math.min(5, Math.max(1, Number(e.target.value) || 1)))
              }
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Counting the first. At 1, failed and timed-out Runs do not retry, but an initial
              scheduled Run on an enabled routine without an approval gate still receives one
              recovery attempt after an hour if a restart interrupts it. Retries re-run the whole
              brief and are at-least-once — an interrupted Run may already have sent the email. Use
              Cancel retry on the Run if repeating its actions would be unsafe.
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Input
              label="Retry backoff (seconds)"
              type="number"
              min={10}
              max={21600}
              disabled={maxAttempts <= 1}
              value={String(retryBackoffSec)}
              onChange={(e) => setRetryBackoffSec(Math.max(10, Number(e.target.value) || 60))}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {maxAttempts <= 1
                ? "Interrupted Runs use a fixed one-hour recovery delay while Attempts is 1."
                : `Doubles each attempt with jitter — roughly ${backoffPreview(retryBackoffSec, maxAttempts)}.`}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                disabled={maxAttempts <= 1}
                checked={retryOnTimeout}
                onChange={(e) => setRetryOnTimeout(e.target.checked)}
              />
              Retry runs that timed out
            </label>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Off by default: a timed-out Run re-burns its full time budget on the retry.
            </div>
          </div>
        </CardBody>
      </Card>

      <TriggersCard company={company} routine={routine} />

      <Card>
        <CardBody className="flex flex-col gap-2">
          <SectionLabel>Webhook</SectionLabel>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={webhookEnabled}
                onChange={(e) => toggleWebhook(e.target.checked)}
              />
              Trigger via incoming webhook
            </label>
            {webhookEnabled && webhookToken && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await toggleWebhook(false);
                  await toggleWebhook(true);
                }}
              >
                Regenerate token
              </Button>
            )}
          </div>
          <FormError message={webhookError} />
          <div className="text-xs text-slate-500 dark:text-slate-400">
            External systems POST here to fire this routine. The URL itself is the credential — keep
            it secret. This one saves immediately.
          </div>
          {webhookUrl && (
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                {webhookUrl}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  setWebhookNotice(null);
                  const ok = await copyToClipboard(webhookUrl);
                  if (!ok) {
                    void dialog.error("Could not access the clipboard.", {
                      title: "Couldn’t copy the webhook URL",
                    });
                    return;
                  }
                  setWebhookNotice("Webhook URL copied.");
                }}
              >
                <Copy size={12} />
              </Button>
            </div>
          )}
          <FormSuccess message={webhookNotice} />
        </CardBody>
      </Card>

      <FormError message={error} />

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>

      <Card className="border-rose-200 dark:border-rose-500/30">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Delete this routine
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              The schedule and its brief go away. Past Run logs and browser recordings are deleted
              with it.
            </div>
          </div>
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await dialog.confirm({
                title: `Delete routine "${routine.name}"?`,
                message:
                  "The schedule and its brief will be removed, along with this routine's Run logs and browser recordings.",
                confirmLabel: "Delete routine",
                variant: "danger",
              });
              if (!ok) return;
              try {
                await api.del(`/api/companies/${company.id}/routines/${routine.id}`);
                await onSaved();
                navigate(`/c/${company.slug}/routines`, { replace: true });
              } catch (err) {
                void dialog.error(err, { title: "Couldn’t delete the routine" });
              }
            }}
          >
            <Trash2 size={14} /> Delete
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

// ───────────────────────────── Triggers ─────────────────────────────────

/**
 * Event subscriptions that fire this routine (M54). Like the Webhook card,
 * everything here saves immediately through its own endpoints rather than
 * riding the Save button — a trigger is its own row, not a field on the
 * routine. Reads are member-level; the toggle, delete, and add form are
 * admin-only.
 */
function TriggersCard({ company, routine }: { company: Company; routine: RoutineWithMeta }) {
  const [data, setData] = React.useState<RoutineTriggerList | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      setData(
        await api.get<RoutineTriggerList>(
          `/api/companies/${company.id}/routine-triggers/routine/${routine.id}`,
        ),
      );
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the triggers"));
      setData({ kinds: [], triggers: [] });
    }
  }, [company.id, routine.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  // Trigger changes ride the routine's own live-sync kind, scoped by
  // routineId — another admin's edit lands here without a manual refresh.
  useLiveRefetch("routine", reload, routine.id);

  async function toggle(trigger: RoutineTrigger, enabled: boolean) {
    setBusyId(trigger.id);
    setRowError(null);
    try {
      await api.patch(`/api/companies/${company.id}/routine-triggers/${trigger.id}`, { enabled });
      await reload();
    } catch (err) {
      setRowError(errorMessage(err, "Could not update the trigger"));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(trigger: RoutineTrigger) {
    setBusyId(trigger.id);
    setRowError(null);
    try {
      await api.del(`/api/companies/${company.id}/routine-triggers/${trigger.id}`);
      await reload();
    } catch (err) {
      setRowError(errorMessage(err, "Could not delete the trigger"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <SectionLabel>Triggers</SectionLabel>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Fires this routine when the chosen resource family changes anywhere in the company — an
          approval first when the routine is gated.
        </div>
        {loadError ? (
          <FormError message={loadError} />
        ) : data === null ? (
          <Spinner />
        ) : (
          <>
            <FormError message={rowError} />
            {data.triggers.length > 0 && (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.triggers.map((trigger) => (
                  <li key={trigger.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                      <Zap size={10} className="mr-1 inline-block" aria-hidden="true" />
                      {trigger.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-600 dark:text-slate-300">
                      at most every {Math.round(trigger.minIntervalSec / 60)}min
                    </span>
                    <span
                      className="shrink-0 text-xs text-slate-400 dark:text-slate-500"
                      title={
                        trigger.lastFiredAt
                          ? new Date(trigger.lastFiredAt).toLocaleString()
                          : undefined
                      }
                    >
                      {trigger.lastFiredAt
                        ? `last fired ${timeAgo(trigger.lastFiredAt)}`
                        : "never fired"}
                    </span>
                    {canManage && (
                      <>
                        <EnabledToggle
                          enabled={trigger.enabled}
                          label={`${trigger.enabled ? "Disable" : "Enable"} the ${trigger.kind} trigger`}
                          disabled={busyId !== null}
                          onChange={(next) => void toggle(trigger, next)}
                        />
                        <button
                          type="button"
                          onClick={() => void remove(trigger)}
                          disabled={busyId !== null}
                          aria-label={`Delete the ${trigger.kind} trigger`}
                          className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-red-400"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                    {!canManage && !trigger.enabled && (
                      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        off
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.triggers.length === 0 && !canManage && (
              <div className="text-sm text-slate-400 dark:text-slate-500">
                No triggers — this routine fires on its schedule only.
              </div>
            )}
            {canManage && (
              <AddTriggerForm
                company={company}
                routine={routine}
                kinds={data.kinds}
                onAdded={() => void reload()}
              />
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function AddTriggerForm({
  company,
  routine,
  kinds,
  onAdded,
}: {
  company: Company;
  routine: RoutineWithMeta;
  kinds: string[];
  onAdded: () => void;
}) {
  const [kind, setKind] = React.useState("");
  const [minutes, setMinutes] = React.useState(15);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) {
      setError("Pick what to listen for.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/routine-triggers`, {
        routineId: routine.id,
        kind,
        minIntervalSec: minutes * 60,
      });
      setKind("");
      setMinutes(15);
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Could not add the trigger"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <FormError message={error} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1">
          <Select label="When this changes" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Choose a resource family…</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Input
            label="At most every (min)"
            type="number"
            min={1}
            max={10080}
            value={String(minutes)}
            onChange={(e) =>
              setMinutes(Math.min(10080, Math.max(1, Math.round(Number(e.target.value) || 15))))
            }
          />
        </div>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Adding…" : "Add trigger"}
        </Button>
      </div>
    </form>
  );
}
