import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  FilePenLine,
  FileText,
  GitBranch,
  Inbox,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { MailReviewEvent, MailReviewSummary, MailReviewTimelineData } from "@/lib/mail";
import { mailReviewDescription, mailReviewHref } from "@/lib/mailReview";
import { MailReviewBadge } from "@/components/mail/MailReviewBadge";
import { clsx } from "@/components/ui/clsx";

const PREVIEW_EVENTS = 6;

function eventIcon(event: MailReviewEvent) {
  if (event.status === "failed") return TriangleAlert;
  if (event.status === "running") return LoaderCircle;
  if (event.status === "pending") return Clock3;
  switch (event.kind) {
    case "received":
      return Inbox;
    case "review_started":
      return Sparkles;
    case "review_completed":
      return Check;
    case "decision":
      return MessageSquare;
    case "draft":
      return FilePenLine;
    case "sent":
      return Send;
    case "quote":
      return FileText;
    case "approval":
      return ListChecks;
    case "handover_queued":
    case "handover_started":
    case "handover_completed":
      return GitBranch;
    default:
      return CircleDot;
  }
}

function eventTime(occurredAt: string): { short: string; full: string } | null {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    short: date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    full: date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }),
  };
}

export function MailReviewTimeline({
  review,
  timeline,
  companySlug,
  error,
  onRetry,
}: {
  review?: MailReviewSummary;
  timeline: MailReviewTimelineData | null;
  companySlug: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [showEarlier, setShowEarlier] = React.useState(false);
  const headingId = React.useId();
  const events = timeline?.events ?? [];
  const hasEarlier = events.length > PREVIEW_EVENTS;
  const visibleEvents = showEarlier ? events : events.slice(-PREVIEW_EVENTS);
  const active = review?.status === "reviewing" || review?.status === "queued";

  return (
    <section
      aria-labelledby={headingId}
      className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 sm:px-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Sparkles size={15} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            AI work timeline
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            From incoming email to what happened next
          </p>
        </div>
        <div aria-live="polite" aria-atomic="true">
          <MailReviewBadge review={review} />
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="border-t border-slate-100 px-5 py-4 text-xs text-amber-800 dark:border-slate-800 dark:text-amber-300"
        >
          <p>{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          )}
        </div>
      ) : timeline === null ? (
        <div
          role="status"
          className="flex items-center gap-2 border-t border-slate-100 px-5 py-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400"
        >
          <LoaderCircle size={13} aria-hidden="true" className="motion-safe:animate-spin" /> Loading
          the timeline…
        </div>
      ) : (
        <>
          <div className="border-t border-slate-100 px-4 pb-1 pt-4 sm:px-5 dark:border-slate-800">
            {hasEarlier && (
              <button
                type="button"
                onClick={() => setShowEarlier((value) => !value)}
                aria-expanded={showEarlier}
                className="mb-4 ml-10 inline-flex items-center gap-1.5 rounded text-xs font-medium text-indigo-600 outline-none hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                {showEarlier ? (
                  <ChevronUp size={13} aria-hidden="true" />
                ) : (
                  <ChevronDown size={13} aria-hidden="true" />
                )}
                {showEarlier
                  ? "Show recent events"
                  : `Show ${events.length - PREVIEW_EVENTS} earlier ${events.length - PREVIEW_EVENTS === 1 ? "event" : "events"}`}
              </button>
            )}
            <ol aria-label="Email and AI work in chronological order">
              {visibleEvents.map((event, index, shown) => (
                <TimelineEvent
                  key={event.id}
                  event={event}
                  companySlug={companySlug}
                  last={index === shown.length - 1}
                />
              ))}
            </ol>
            {events.length === 0 && (
              <p className="pb-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                No activity has been recorded for this conversation yet.
              </p>
            )}
          </div>
          {(review?.status === "not_reviewed" || active || timeline.truncated) && (
            <div className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-[11px] leading-relaxed text-slate-500 sm:px-5 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
              {active ? (
                <LoaderCircle
                  size={12}
                  className="mt-0.5 shrink-0 text-indigo-500 motion-safe:animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <CircleDot size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              )}
              <p>
                {timeline.truncated ? "Showing the most recent recorded activity. " : ""}
                {(review?.status === "not_reviewed" || active) && mailReviewDescription(review)}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TimelineEvent({
  event,
  companySlug,
  last,
}: {
  event: MailReviewEvent;
  companySlug: string;
  last: boolean;
}) {
  const Icon = eventIcon(event);
  const href = mailReviewHref(companySlug, event.href);
  const time = eventTime(event.occurredAt);
  const action = ["decision", "draft", "sent", "quote", "approval", "action"].includes(event.kind);
  const failure = event.status === "failed";
  const running = event.status === "running";
  return (
    <li className="relative flex gap-3 pb-4" data-timeline-kind={event.kind}>
      {!last && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-[13px] top-7 w-px bg-slate-200 dark:bg-slate-800"
        />
      )}
      <span
        aria-hidden="true"
        className={clsx(
          "relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white dark:ring-slate-950",
          failure
            ? "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
            : running || action
              ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
        )}
      >
        <Icon size={13} className={running ? "motion-safe:animate-spin" : undefined} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          {href ? (
            <Link
              to={href}
              className="group/link inline-flex min-w-0 items-center gap-1 rounded text-xs font-medium text-slate-800 outline-none hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-slate-200 dark:hover:text-indigo-300"
            >
              <span className="min-w-0 break-words">{event.title}</span>
              <ArrowUpRight
                size={12}
                className="shrink-0 text-slate-400 group-hover/link:text-indigo-500"
                aria-hidden="true"
              />
            </Link>
          ) : (
            <span
              className={clsx(
                "min-w-0 break-words text-xs font-medium",
                failure
                  ? "text-amber-800 dark:text-amber-300"
                  : "text-slate-800 dark:text-slate-200",
              )}
            >
              {event.title}
            </span>
          )}
          {time && (
            <time
              dateTime={event.occurredAt}
              title={time.full}
              className="shrink-0 text-[10px] tabular-nums text-slate-400 dark:text-slate-500"
            >
              {time.short}
            </time>
          )}
        </div>
        {event.employee && (
          <p className="mt-0.5 break-words text-[11px] font-medium text-slate-500 dark:text-slate-400">
            {event.employee.name}
          </p>
        )}
        {event.description && (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {event.description}
          </p>
        )}
      </div>
    </li>
  );
}
