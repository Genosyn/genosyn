import React from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock,
  Clock3,
  Info,
  RotateCcw,
  X,
} from "lucide-react";
import { api, Company, Decision, DecisionStatus } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { ChatMarkdown } from "../ChatMarkdown";
import { Avatar, employeeAvatarUrl } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { clsx } from "../ui/clsx";
import { FormError } from "../ui/FormError";
import { Spinner } from "../ui/Spinner";
import { DecisionPickup } from "./DecisionPickup";
import { DecisionSourceLine } from "./DecisionSource";
import { DecisionDiscussButton } from "./DecisionDiscussButton";
import { ReviewTimeline, ReviewTimelineItem, type ReviewTimelineTone } from "./ReviewTimeline";
import { formatRelative } from "./relative";

/** Resolved choices keep the same visual story as the card that asked them. */
const RESOLVED_STYLE: Record<
  Exclude<DecisionStatus, "pending">,
  { label: string; cls: string; tone: ReviewTimelineTone }
> = {
  decided: {
    label: "answered",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    tone: "success",
  },
  cancelled: {
    label: "dismissed",
    cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
    tone: "neutral",
  },
  expired: {
    label: "expired",
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    tone: "warning",
  },
};

const PICKUP_TIMELINE = {
  running: { icon: Clock3, tone: "accent" },
  done: { icon: CheckCircle2, tone: "success" },
  failed: { icon: AlertTriangle, tone: "warning" },
  skipped: { icon: CircleSlash, tone: "neutral" },
} as const;

export function DecisionOutcome({
  company,
  decision,
  onRestored,
  canRestore,
  onClose,
  refreshNotice,
  keepExpanded = false,
}: {
  company: Company;
  decision: Decision;
  onRestored: (announcement?: string) => Promise<void> | void;
  canRestore: boolean;
  onClose?: () => void;
  refreshNotice?: React.ReactNode;
  keepExpanded?: boolean;
}) {
  const [contextOpen, setContextOpen] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [restoreError, setRestoreError] = React.useState<string | null>(null);
  const restoringRef = React.useRef(false);
  const fieldId = React.useId();
  const status = decision.status as Exclude<DecisionStatus, "pending">;
  const style = RESOLVED_STYLE[status];
  const StatusIcon = status === "decided" ? Check : status === "expired" ? Clock : CircleSlash;
  const employeeName = decision.employee?.name ?? "Deleted AI Employee";
  const resolvedBy = decision.decidedByEmployee
    ? `${decision.decidedByEmployee.name} (AI)`
    : (decision.decidedBy?.name ?? null);
  const resolutionTitle =
    status === "decided"
      ? "The answer"
      : status === "cancelled"
        ? "The decision was dismissed"
        : "Expired under an earlier version";
  const pickup = decision.pickupStatus === "none" ? null : PICKUP_TIMELINE[decision.pickupStatus];
  const mayRestore = status === "cancelled" && decision.decidedByUserId !== null && canRestore;

  async function restore() {
    if (!mayRestore || restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    setRestoreError(null);
    try {
      await api.post(`/api/companies/${company.id}/decisions/${decision.id}/restore`, {});
      await onRestored(`Decision “${decision.title}” restored to the stack.`);
    } catch (err) {
      setRestoreError(errorMessage(err));
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }
  }

  return (
    <li id={`decision-${decision.id}`} className="scroll-mt-4">
      <article
        aria-labelledby={`${fieldId}-title`}
        className={clsx(
          "min-w-0 bg-white dark:bg-slate-900",
          onClose
            ? "px-4 py-5 sm:px-5"
            : "rounded-xl border border-slate-200 p-4 shadow-sm dark:border-slate-800",
        )}
      >
        <header className="flex min-w-0 items-start gap-2.5">
          {decision.employee && (
            <Avatar
              name={decision.employee.name}
              kind="ai"
              size="sm"
              src={employeeAvatarUrl(company.id, decision.employee.id, decision.employee.avatarKey)}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={clsx(
                  "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  style.cls,
                )}
              >
                {style.label}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {formatRelative(decision.decidedAt ?? decision.createdAt)}
              </span>
            </div>
            <h3
              id={`${fieldId}-title`}
              className="mt-1.5 break-words text-sm font-semibold leading-snug text-slate-900 dark:text-slate-100"
            >
              {decision.title}
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Asked by {employeeName}
            </p>
          </div>
          {onClose && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Close decision"
              onClick={onClose}
              className="shrink-0"
            >
              <X size={14} /> Close
            </Button>
          )}
        </header>

        <ReviewTimeline className="mt-4">
          <ReviewTimelineItem icon={Info} title="What happened">
            <DecisionSourceLine company={company} decision={decision} />
            {decision.body && (
              <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                <div
                  id={`${fieldId}-context`}
                  className={clsx(
                    "break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300",
                    contextOpen ? "max-h-[32rem] overflow-auto" : "max-h-24 overflow-hidden",
                  )}
                >
                  <ChatMarkdown content={decision.body} />
                </div>
                <button
                  type="button"
                  onClick={() => setContextOpen((value) => !value)}
                  aria-expanded={contextOpen}
                  aria-controls={`${fieldId}-context`}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {contextOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  {contextOpen ? "Show less" : "Read the full context"}
                </button>
              </div>
            )}
          </ReviewTimelineItem>

          <ReviewTimelineItem
            icon={StatusIcon}
            title={resolutionTitle}
            tone={style.tone}
            meta={formatRelative(decision.decidedAt ?? decision.createdAt)}
          >
            {status === "decided" ? (
              <div className="space-y-2">
                <div className="inline-flex max-w-full items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    {decision.chosenOptionLabel ?? "Answer recorded"}
                  </span>
                </div>
                {resolvedBy && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Answered by {resolvedBy}
                  </p>
                )}
              </div>
            ) : status === "cancelled" ? (
              <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                Closed without recording an answer{resolvedBy ? ` by ${resolvedBy}` : ""}.
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                This Decision expired before deadlines were retired. Pending Decisions now stay open
                until someone answers them, a Member dismisses them, or the AI Employee retracts
                them.
              </p>
            )}

            {decision.note && (
              <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {status === "cancelled" ? "Reason" : "Guidance"}:
                </span>{" "}
                <span className="break-words">{decision.note}</span>
              </div>
            )}
          </ReviewTimelineItem>

          {pickup && (
            <ReviewTimelineItem
              icon={pickup.icon}
              title="What happened next"
              tone={pickup.tone}
              meta={
                decision.pickupFinishedAt || decision.pickupStartedAt
                  ? formatRelative(decision.pickupFinishedAt ?? decision.pickupStartedAt!)
                  : undefined
              }
            >
              <DecisionPickup decision={decision} keepExpanded={keepExpanded} />
            </ReviewTimelineItem>
          )}
          {status === "decided" && !pickup && (
            <ReviewTimelineItem icon={Clock3} title="What happens next">
              <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                Your answer is recorded. Follow-up progress will appear here when the AI Employee
                picks it up.
              </p>
            </ReviewTimelineItem>
          )}
        </ReviewTimeline>

        {refreshNotice}
        <FormError message={restoreError} className="mt-3" />
        <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:justify-end dark:border-slate-800">
          {onClose && (
            <p className="text-xs leading-relaxed text-slate-500 sm:mr-auto dark:text-slate-400">
              Close removes this card from the active stack. Its timeline stays in history
              {decision.pickupStatus === "running" ? ", and work continues." : "."}
            </p>
          )}
          {mayRestore && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={restoring}
              onClick={() => void restore()}
              className="w-full sm:w-auto"
            >
              {restoring ? <Spinner size={14} /> : <RotateCcw size={14} />}
              Undismiss
            </Button>
          )}
          <DecisionDiscussButton company={company} decision={decision} disabled={restoring} />
        </div>
      </article>
    </li>
  );
}
