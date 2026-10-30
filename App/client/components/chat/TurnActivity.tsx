import React from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Brain,
  Calculator,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock,
  Code2,
  Database,
  FileText,
  Globe,
  Hand,
  Info,
  KeyRound,
  ListChecks,
  Mail,
  MessageSquare,
  MousePointerClick,
  OctagonX,
  RefreshCw,
  RotateCcw,
  Search,
  Shrink,
  Square,
  Terminal,
  Users,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  describeChatToolCall,
  formatElapsed,
  formatStepDuration,
  type ChatActivityEvent,
  type ChatToolFamily,
  type TurnActivitySummary,
} from "../../../shared/chatActivity";
import { api } from "../../lib/api";
import {
  buildActivitySteps,
  countSteps,
  latestProgress,
  visibleSteps,
  type ActivityStep,
  type LiveTurnState,
  type ToolStep,
} from "../../lib/chatActivity";
import {
  describeLivePhase,
  deriveLivePhase,
  headlineOf,
  type LivePhase,
} from "../../lib/chatLiveness";
import { ChatMarkdown } from "../ChatMarkdown";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { Skeleton } from "../ui/Skeleton";
import { ButtonSpinner } from "../ui/Spinner";
import { clsx } from "../ui/clsx";

/**
 * What an AI Employee is doing while it answers, and what it did once it has.
 *
 * A running turn is a card under the employee's name: one status line that
 * says what is happening right now and for how long — working, waiting on
 * something named, or quiet — a Stop button, the employee's own milestone
 * when it reported one, and the steps so far, newest last. The reply streams
 * in beneath it. A finished reply carries one quiet line, "Worked for 2m 14s
 * · 9 steps", that opens onto the same steps with their inputs, outputs and
 * errors. Both read the same recorded events, so a reload, another tab, or a
 * visit next week shows the same history.
 */

/** Steps the live card shows before folding the older ones away. */
const LIVE_STEP_WINDOW = 6;

/** Re-render on a clock while `active`, for elapsed times and quiet detection. */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

// ───────────────────────────── the live card ─────────────────────────────

export function LiveTurnCard({
  authorName,
  avatar,
  live,
  streamingReply,
  progress,
  connectionState,
  stopping,
  onStop,
  companySlug,
}: {
  authorName: string;
  avatar: React.ReactNode;
  live: LiveTurnState;
  streamingReply: string | null;
  /** The employee's own milestone from the progress control. */
  progress: { percent: number; label: string } | null;
  connectionState: "streaming" | "polling" | "reconnecting" | null;
  /** A stop this browser asked for is still landing. */
  stopping: boolean;
  onStop?: () => void;
  companySlug: string;
}) {
  const clientNow = useNow(true);
  const now = clientNow + live.clockOffsetMs;
  const startedAt = live.startedAt ?? now;
  const phase = deriveLivePhase({
    events: live.events,
    startedAt,
    now,
    lastTextAt: live.lastTextAt,
    lastSignalAt: live.lastSignalAt,
    connection: connectionState,
    stopping,
    hasReplyText: Boolean(streamingReply && streamingReply.length > 0),
  });
  const words = describeLivePhase(phase, authorName, now);
  const steps = React.useMemo(() => visibleSteps(buildActivitySteps(live.events)), [live.events]);
  const milestone = latestProgress(live.events) ?? progress;
  const hasReply = Boolean(streamingReply && streamingReply.length > 0);
  // The live region speaks when the status changes, never on the clock's tick.
  const announcement = `${authorName}: ${words.announce}`;

  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-9 shrink-0">{avatar}</div>
      <div className="min-w-0 max-w-[85%] flex-1 sm:max-w-[75%]">
        <div className="mb-1 flex items-center gap-2 text-[11px]">
          <span className="font-medium text-slate-700 dark:text-slate-200">{authorName}</span>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </span>
        </div>
        <section
          aria-label={`${authorName} is working`}
          className="overflow-hidden rounded-2xl rounded-tl-md border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex items-start gap-2.5 px-3.5 py-2.5">
            <PhaseIcon phase={phase} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  className={clsx(
                    "min-w-0 truncate text-sm font-medium",
                    words.tone === "warning"
                      ? "text-amber-800 dark:text-amber-300"
                      : "text-slate-800 dark:text-slate-100",
                  )}
                  title={words.title}
                >
                  {words.title}
                </span>
                {phaseShowsOwnClock(phase) && (
                  <span
                    className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400"
                    aria-hidden="true"
                  >
                    {formatElapsed(Math.max(0, now - phase.since))}
                  </span>
                )}
                <span
                  className="ml-auto shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500"
                  title="Time since the message was sent"
                >
                  <span className="sr-only">Working for </span>
                  {formatElapsed(Math.max(0, now - startedAt))}
                </span>
              </div>
              {phase.kind === "tool" && phase.step.target && (
                <div
                  className={clsx(
                    "mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400",
                    phase.step.targetIsCode && "font-mono",
                  )}
                  title={phase.step.target}
                >
                  {phase.step.target}
                </div>
              )}
              {words.detail && (
                <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {words.detail}
                </p>
              )}
            </div>
            {onStop && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={stopping}
                onClick={onStop}
                aria-label={
                  stopping ? `Stopping ${authorName}’s reply` : `Stop ${authorName}’s reply`
                }
                title={`Stop ${authorName}. What was written so far is kept.`}
                className="-my-1 -mr-1.5 shrink-0 px-2.5 text-xs"
              >
                <Square size={11} fill="currentColor" aria-hidden="true" />
                {stopping ? "Stopping" : "Stop"}
              </Button>
            )}
          </div>
          {milestone && <Milestone authorName={authorName} {...milestone} />}
          {steps.length > 0 && (
            <ActivityStepList
              steps={steps}
              now={now}
              live
              limit={LIVE_STEP_WINDOW}
              companySlug={companySlug}
            />
          )}
        </section>
        {hasReply && (
          <div className="mt-2 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            <ChatMarkdown content={streamingReply ?? ""} />
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-[2px] bg-indigo-500 motion-reduce:hidden"
              style={{ animation: "chatCursor 1s steps(2) infinite" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** A tool's own duration is on its row; the header clock is for waits and thinking. */
function phaseShowsOwnClock(phase: LivePhase): phase is Extract<LivePhase, { since: number }> {
  return phase.kind === "waiting" || phase.kind === "thinking" || phase.kind === "tool";
}

function PhaseIcon({ phase }: { phase: LivePhase }) {
  const box = "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg";
  if (phase.kind === "quiet") {
    return (
      <span
        className={clsx(box, "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300")}
      >
        <AlertTriangle size={13} aria-hidden="true" />
      </span>
    );
  }
  if (phase.kind === "reconnecting") {
    return (
      <span
        className={clsx(box, "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300")}
      >
        <RefreshCw size={13} className="motion-safe:animate-spin" aria-hidden="true" />
      </span>
    );
  }
  if (phase.kind === "waiting") {
    return (
      <span
        className={clsx(box, "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}
      >
        <Clock size={13} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className={clsx(
        box,
        "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
      )}
    >
      <ButtonSpinner size={13} className="motion-reduce:animate-none" />
    </span>
  );
}

function Milestone({
  authorName,
  percent,
  label,
}: {
  authorName: string;
  percent: number;
  label: string;
}) {
  return (
    <div className="border-t border-slate-100 px-3.5 py-2 dark:border-slate-800">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-slate-600 dark:text-slate-300" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{percent}%</span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="progressbar"
        aria-label={`${authorName}'s progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${label}, ${percent}% complete`}
      >
        <div
          className="h-full rounded-full bg-indigo-600 transition-[width] duration-500 ease-out dark:bg-indigo-500"
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
    </div>
  );
}

// ───────────────────────────── the finished line ─────────────────────────────

/** Whether a finished reply has anything worth a "Worked for" line. */
export function shouldShowTurnSummary(summary: TurnActivitySummary | null | undefined): boolean {
  if (!summary) return false;
  return (
    summary.steps > 0 ||
    summary.reasoning ||
    summary.waitedMs >= 1_000 ||
    summary.durationMs >= 15_000
  );
}

/** "Worked for 2m 14s · 9 steps", or "Thought for 12s" when there were no steps. */
export function turnSummaryLabel(summary: TurnActivitySummary): string {
  const time = formatElapsed(summary.durationMs);
  if (summary.steps > 0) {
    return `Worked for ${time} · ${summary.steps} ${summary.steps === 1 ? "step" : "steps"}`;
  }
  return summary.reasoning ? `Thought for ${time}` : `Worked for ${time}`;
}

/** Events of finished turns already read in this tab; they never change. */
const finishedTurnEvents = new Map<string, ChatActivityEvent[]>();

function useFinishedTurnEvents(url: string, messageId: string, enabled: boolean) {
  const [events, setEvents] = React.useState<ChatActivityEvent[] | null>(
    () => finishedTurnEvents.get(messageId) ?? null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!enabled || events) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const collected: ChatActivityEvent[] = [];
        let after = 0;
        for (let page = 0; page < 5; page += 1) {
          const result = await api.get<{ events: ChatActivityEvent[]; more: boolean }>(
            `${url}?after=${after}&limit=1000`,
          );
          collected.push(...result.events);
          if (!result.more || result.events.length === 0) break;
          after = result.events[result.events.length - 1].ordinal;
        }
        if (cancelled) return;
        finishedTurnEvents.set(messageId, collected);
        setEvents(collected);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || "Could not load what happened.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, events, messageId, url, attempt]);
  return { events, error, retry: () => setAttempt((value) => value + 1) };
}

export function TurnWorkSummary({
  summary,
  activityUrl,
  messageId,
  companySlug,
}: {
  summary: TurnActivitySummary;
  /** `…/conversations/:convId/messages/:messageId/activity`. */
  activityUrl: string;
  messageId: string;
  companySlug: string;
}) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const { events, error, retry } = useFinishedTurnEvents(activityUrl, messageId, open);
  const steps = React.useMemo(
    () =>
      events
        ? visibleSteps(
            buildActivitySteps(events, { finishedAt: Date.parse(summary.endedAt) || null }),
          )
        : [],
    [events, summary.endedAt],
  );
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="-ml-1.5 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={clsx("shrink-0 transition-transform", open && "rotate-90")}
        />
        <ListChecks size={12} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{turnSummaryLabel(summary)}</span>
        {summary.failed > 0 && (
          <span className="shrink-0 font-medium text-rose-700 dark:text-rose-300">
            · {summary.failed} failed
          </span>
        )}
        {summary.held > 0 && (
          <span className="shrink-0 font-medium text-amber-700 dark:text-amber-300">
            · {summary.held} waiting for approval
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
          aria-busy={!events && !error}
        >
          {error ? (
            <div className="p-3">
              <FormError message={error} />
              <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={retry}>
                <RotateCcw size={13} aria-hidden="true" /> Try again
              </Button>
            </div>
          ) : !events ? (
            <div className="space-y-2.5 px-3.5 py-3">
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : steps.length === 0 ? (
            <p className="px-3.5 py-3 text-xs text-slate-500 dark:text-slate-400">
              No steps were recorded for this reply.
            </p>
          ) : (
            <ActivityStepList
              steps={steps}
              now={Date.parse(summary.endedAt)}
              companySlug={companySlug}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── the step list ─────────────────────────────

export function ActivityStepList({
  steps,
  now,
  live = false,
  limit,
  companySlug,
}: {
  steps: ActivityStep[];
  now: number;
  live?: boolean;
  /** Show only the newest N, with the rest behind "Show N earlier steps". */
  limit?: number;
  companySlug: string;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const hidden = limit && !showAll ? Math.max(0, steps.length - limit) : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  const counts = countSteps(steps);
  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-xs text-slate-500 transition hover:bg-slate-50 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
        >
          <ChevronRight size={12} aria-hidden="true" />
          Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
        </button>
      )}
      <ol
        className="py-1"
        aria-label={`Steps${counts.tools ? `: ${counts.tools} tool ${counts.tools === 1 ? "call" : "calls"}` : ""}${counts.failed ? `, ${counts.failed} failed` : ""}`}
      >
        {shown.map((step) => (
          <StepRow key={step.key} step={step} now={now} live={live} companySlug={companySlug} />
        ))}
      </ol>
    </div>
  );
}

const FAMILY_ICON: Record<ChatToolFamily, LucideIcon> = {
  command: Terminal,
  file: FileText,
  search: Search,
  web: Globe,
  browser: MousePointerClick,
  mail: Mail,
  finance: Calculator,
  data: Database,
  message: MessageSquare,
  plan: ListChecks,
  people: Users,
  code: Code2,
  tool: Wrench,
};

const NOTE_ICON: Record<string, LucideIcon> = {
  stopped: OctagonX,
  resumed: RotateCcw,
  retry: RotateCcw,
  retry_requested: RotateCcw,
  compact: Shrink,
  key_failover: KeyRound,
};

function StepRow({
  step,
  now,
  live,
  companySlug,
}: {
  step: ActivityStep;
  now: number;
  live: boolean;
  companySlug: string;
}) {
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();

  if (step.kind === "note") {
    const Icon = NOTE_ICON[step.code] ?? Info;
    const stopped = step.code === "stopped";
    return (
      <li
        className={clsx(
          "flex items-center gap-2 px-3.5 py-1 text-xs",
          stopped ? "text-amber-800 dark:text-amber-300" : "text-slate-500 dark:text-slate-400",
        )}
      >
        <Icon size={12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate" title={step.label}>
          {noteLabel(step)}
        </span>
      </li>
    );
  }

  const running =
    (step.kind === "tool" && step.status === "running") ||
    ((step.kind === "thinking" || step.kind === "wait") && step.endedAt === null);
  const duration =
    step.kind === "tool"
      ? (step.durationMs ?? (running ? now - step.startedAt : null))
      : (step.endedAt ?? now) - step.startedAt;
  const durationText =
    duration === null
      ? ""
      : running
        ? formatElapsed(Math.max(0, duration))
        : formatStepDuration(duration);
  const view = rowView(step, running);
  const expandable =
    step.kind === "thinking"
      ? Boolean(step.text.trim())
      : step.kind === "tool" || Boolean(view.reason);

  const content = (
    <>
      <StatusGlyph step={step} running={running} />
      <view.Icon
        size={13}
        aria-hidden="true"
        className="shrink-0 text-slate-400 dark:text-slate-500"
      />
      <span
        className="min-w-0 flex-1 truncate"
        title={[view.label, view.target].filter(Boolean).join(" · ")}
      >
        <span className={clsx(view.tone)}>{view.label}</span>
        {view.target && (
          <>
            {" "}
            <span
              className={clsx(
                "ml-1 text-slate-500 dark:text-slate-400",
                view.targetIsCode && "font-mono text-[11px]",
              )}
            >
              {view.target}
            </span>
          </>
        )}
      </span>
      {step.kind === "tool" && step.worker && (
        <Badge
          tone="neutral"
          capitalize={false}
          className="hidden sm:inline-flex"
          title="Parallel worker"
        >
          {step.worker}
        </Badge>
      )}
      {step.kind === "tool" && step.status === "held" && (
        <Badge tone="warning" className="shrink-0">
          Waiting for approval
        </Badge>
      )}
      {durationText && (
        <span className="shrink-0 tabular-nums text-slate-400 dark:text-slate-500">
          {durationText}
        </span>
      )}
    </>
  );

  return (
    <li className="min-w-0">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          className="flex w-full min-w-0 items-center gap-2 px-3.5 py-1.5 text-left text-xs transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus dark:hover:bg-slate-800/60"
        >
          {content}
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={clsx("shrink-0 text-slate-400 transition-transform", open && "rotate-90")}
          />
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-3.5 py-1.5 text-xs">{content}</div>
      )}
      {open && expandable && (
        <div
          id={detailId}
          className="space-y-2 border-y border-slate-100 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/40"
        >
          <StepDetail step={step} live={live} reason={view.reason} companySlug={companySlug} />
        </div>
      )}
    </li>
  );
}

function rowView(
  step: Exclude<ActivityStep, { kind: "note" }>,
  running: boolean,
): {
  Icon: LucideIcon;
  label: string;
  target: string;
  targetIsCode: boolean;
  tone: string;
  reason: string | null;
} {
  if (step.kind === "tool") {
    return {
      Icon: FAMILY_ICON[step.family] ?? Wrench,
      label: step.status === "failed" ? `${step.label} — failed` : step.label,
      target: step.target,
      targetIsCode: step.targetIsCode,
      tone:
        step.status === "failed"
          ? "text-rose-700 dark:text-rose-300"
          : "text-slate-700 dark:text-slate-200",
      reason: null,
    };
  }
  if (step.kind === "thinking") {
    const headline = headlineOf(step);
    return {
      Icon: Brain,
      label: running ? "Thinking" : "Thought",
      target: headline ?? "",
      targetIsCode: false,
      tone: "text-slate-700 dark:text-slate-200",
      reason: null,
    };
  }
  const retry =
    step.cause === "model_retry" && step.attempt !== null
      ? `Attempt ${step.attempt}${step.maxAttempts !== null ? ` of ${step.maxAttempts}` : ""}`
      : null;
  return {
    Icon: Clock,
    label: waitRowLabel(step.cause, step.label, running),
    target: "",
    targetIsCode: false,
    tone: "text-slate-600 dark:text-slate-300",
    reason:
      [step.reason ? `Reason: ${step.reason}` : null, retry].filter(Boolean).join(" · ") || null,
  };
}

function waitRowLabel(cause: string, label: string, running: boolean): string {
  switch (cause) {
    case "thread_busy":
      return running ? "Waiting for the previous reply" : "Waited for the previous reply";
    case "model_lock":
      return running ? "Waiting for the AI Model" : "Waited for the AI Model";
    case "model_retry":
      return running ? "Retrying the AI Model" : "Retried the AI Model";
    case "model_outage":
      return running ? "Waiting for the AI Model's server" : "Waited for the AI Model's server";
    default:
      return label;
  }
}

function noteLabel(step: Extract<ActivityStep, { kind: "note" }>): string {
  switch (step.code) {
    case "stopped":
      return "Stopped by a Member";
    case "resumed":
      return "The server restarted mid-turn — resumed from where it was";
    case "retry":
      return "Started again";
    case "retry_requested":
      return "Retry requested";
    default:
      return step.label;
  }
}

function StatusGlyph({ step, running }: { step: ActivityStep; running: boolean }) {
  if (running) {
    return (
      <span
        className="flex w-3.5 shrink-0 justify-center text-indigo-600 dark:text-indigo-300"
        aria-label="Running"
      >
        <ButtonSpinner size={12} className="motion-reduce:animate-none" />
      </span>
    );
  }
  if (step.kind === "tool") {
    if (step.status === "failed") {
      return (
        <XCircle
          size={13}
          className="shrink-0 text-rose-600 dark:text-rose-400"
          aria-label="Failed"
        />
      );
    }
    if (step.status === "held") {
      return (
        <Hand
          size={13}
          className="shrink-0 text-amber-600 dark:text-amber-400"
          aria-label="Waiting for approval"
        />
      );
    }
    if (step.status === "stopped") {
      return (
        <CircleSlash
          size={13}
          className="shrink-0 text-slate-400"
          aria-label="Stopped before it finished"
        />
      );
    }
  }
  return (
    <CheckCircle2
      size={13}
      className="shrink-0 text-emerald-600 dark:text-emerald-400"
      aria-label="Done"
    />
  );
}

function StepDetail({
  step,
  live,
  reason,
  companySlug,
}: {
  step: Exclude<ActivityStep, { kind: "note" }>;
  live: boolean;
  reason: string | null;
  companySlug: string;
}) {
  if (step.kind === "thinking") {
    return (
      <div className="text-xs leading-5 text-slate-600 dark:text-slate-300">
        <ChatMarkdown content={step.text} />
        {step.truncated && (
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            Only the start of this thought was kept.
          </p>
        )}
      </div>
    );
  }
  if (step.kind === "wait") {
    return <p className="text-xs text-slate-600 dark:text-slate-300">{reason}</p>;
  }
  return <ToolDetail step={step} live={live} companySlug={companySlug} />;
}

function ToolDetail({
  step,
  live,
  companySlug,
}: {
  step: ToolStep;
  live: boolean;
  companySlug: string;
}) {
  const described = describeChatToolCall(step.name, step.input);
  const entries = step.input ? Object.entries(step.input) : [];
  return (
    <>
      {step.worker && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Done by a parallel worker: <span className="font-medium">{step.worker}</span>
        </p>
      )}
      {entries.length > 0 && (
        <div>
          <DetailLabel>{described.family === "command" ? "Command" : "Arguments"}</DetailLabel>
          {described.family === "command" && typeof step.input?.command === "string" ? (
            <Pre>{`$ ${step.input.command}`}</Pre>
          ) : (
            <dl className="space-y-1">
              {entries.map(([key, value]) => {
                const text =
                  typeof value === "string"
                    ? value
                    : typeof value === "number" || typeof value === "boolean"
                      ? String(value)
                      : (JSON.stringify(value, null, 2) ?? "");
                const block = text.includes("\n") || text.length > 80;
                return (
                  <div key={key} className={block ? "" : "flex min-w-0 items-baseline gap-2"}>
                    <dt className="shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {key}
                    </dt>
                    <dd className="min-w-0">
                      {block ? (
                        <Pre>{text}</Pre>
                      ) : (
                        <span
                          className="block truncate font-mono text-[11px] text-slate-700 dark:text-slate-200"
                          title={text}
                        >
                          {text}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>
      )}
      {step.status === "held" && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300">
          <Hand size={12} aria-hidden="true" />
          This call is held until an owner or admin approves it.
          <Link
            to={`/c/${companySlug}/decisions/approvals`}
            className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
          >
            Open approvals
          </Link>
        </p>
      )}
      {step.status === "running" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <ButtonSpinner size={10} /> {live ? "Running…" : "No result was recorded."}
        </p>
      ) : step.status === "stopped" ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          The turn ended before this step returned.
        </p>
      ) : step.output !== null ? (
        <div>
          <DetailLabel>{step.status === "failed" ? "Error" : "Result"}</DetailLabel>
          <Pre tone={step.status === "failed" ? "error" : "plain"}>
            {step.output.trim() ? step.output : "(no output)"}
          </Pre>
          {step.images > 0 && (
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Also returned {step.images} {step.images === 1 ? "image" : "images"}, not shown here.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {step.status === "failed"
            ? "It failed; no details were kept."
            : "Done; no details were kept."}
        </p>
      )}
    </>
  );
}

function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{children}</div>
  );
}

/** Verbatim text in its own scroll box, so a long result never widens the page. */
function Pre({ children, tone = "plain" }: { children: string; tone?: "plain" | "error" }) {
  return (
    <pre
      className={clsx(
        "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-2.5 py-2 font-mono text-[11px] leading-4",
        tone === "error"
          ? "border-rose-200 bg-rose-50/70 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
          : "border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
      )}
    >
      {children}
    </pre>
  );
}
