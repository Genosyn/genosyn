import React from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  BellOff,
  Briefcase,
  CalendarDays,
  CheckSquare,
  ExternalLink,
  MailOpen,
  Phone,
  Repeat,
  Send,
  StickyNote,
  Trophy,
  UserPlus,
  XCircle,
  Zap,
} from "lucide-react";

/**
 * The revenue activity timeline — shared by the contact detail and the deal
 * detail so the two pages render the same history the same way.
 *
 * Almost none of this is typed in by a human: mail sync writes `email_in` /
 * `email_out` rows as threads arrive, the deal service writes stage changes,
 * sequences write their touches. So the component is built for a feed that is
 * *already* full on first open — grouped by day, one icon per kind, and a deep
 * link straight into the mail thread for anything mail-derived.
 *
 * Rows arrive newest-first from `GET /revenue/activities` (and from the
 * composite contact / deal detail payloads); the grouping below preserves that
 * order rather than re-sorting, so the server stays the single authority on
 * what "most recent" means.
 */

export type RevenueActivityKind =
  | "email_in"
  | "email_out"
  | "call"
  | "meeting"
  | "note"
  | "task"
  | "deal_created"
  | "stage_change"
  | "deal_won"
  | "deal_lost"
  | "enrollment"
  | "sequence_step"
  | "unsubscribe"
  | "bounce"
  | "signal";

/** One row of `activities` as the server serializes it. */
export type RevenueActivity = {
  id: string;
  companyId: string;
  kind: RevenueActivityKind;
  subject: string;
  bodyText: string;
  occurredAt: string;
  contactId: string | null;
  dealId: string | null;
  customerId: string | null;
  mailThreadId: string | null;
  mailMessageId: string | null;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  metaJson: string | null;
  createdAt: string;
};

type KindMeta = {
  label: string;
  icon: React.ReactNode;
  /** Icon-chip colours. Every class carries its dark: partner. */
  tone: string;
};

const KIND_META: Record<RevenueActivityKind, KindMeta> = {
  email_in: {
    label: "Email received",
    icon: <MailOpen size={13} />,
    tone: "bg-indigo-50 text-indigo-600 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20",
  },
  email_out: {
    label: "Email sent",
    icon: <Send size={13} />,
    tone: "bg-indigo-50 text-indigo-600 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20",
  },
  call: {
    label: "Call",
    icon: <Phone size={13} />,
    tone: "bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20",
  },
  meeting: {
    label: "Meeting",
    icon: <CalendarDays size={13} />,
    tone: "bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20",
  },
  note: {
    label: "Note",
    icon: <StickyNote size={13} />,
    tone: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
  task: {
    label: "Task",
    icon: <CheckSquare size={13} />,
    tone: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
  deal_created: {
    label: "Deal created",
    icon: <Briefcase size={13} />,
    tone: "bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20",
  },
  stage_change: {
    label: "Stage change",
    icon: <ArrowRight size={13} />,
    tone: "bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20",
  },
  deal_won: {
    label: "Deal won",
    icon: <Trophy size={13} />,
    tone: "bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20",
  },
  deal_lost: {
    label: "Deal lost",
    icon: <XCircle size={13} />,
    tone: "bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20",
  },
  enrollment: {
    label: "Sequence enrolment",
    icon: <UserPlus size={13} />,
    tone: "bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  },
  sequence_step: {
    label: "Sequence touch",
    icon: <Repeat size={13} />,
    tone: "bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  },
  unsubscribe: {
    label: "Unsubscribed",
    icon: <BellOff size={13} />,
    tone: "bg-red-50 text-red-600 ring-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/20",
  },
  bounce: {
    label: "Bounced",
    icon: <AlertTriangle size={13} />,
    tone: "bg-red-50 text-red-600 ring-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/20",
  },
  signal: {
    label: "Signal",
    icon: <Zap size={13} />,
    tone: "bg-teal-50 text-teal-600 ring-teal-100 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-500/20",
  },
};

const FALLBACK_META: KindMeta = {
  label: "Activity",
  icon: <StickyNote size={13} />,
  tone: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
};

export function activityKindLabel(kind: RevenueActivityKind): string {
  return (KIND_META[kind] ?? FALLBACK_META).label;
}

type DayGroup = { key: string; label: string; items: RevenueActivity[] };

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date): string {
  const now = new Date();
  if (dayKeyOf(d) === dayKeyOf(now)) return "Today";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayKeyOf(d) === dayKeyOf(yesterday)) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Consecutive rows on the same calendar day, in the order the server sent. */
function groupByDay(rows: RevenueActivity[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const d = new Date(row.occurredAt);
    const valid = !Number.isNaN(d.getTime());
    const key = valid ? dayKeyOf(d) : "unknown";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(row);
      continue;
    }
    groups.push({
      key,
      label: valid ? dayLabel(d) : "Undated",
      items: [row],
    });
  }
  return groups;
}

function parseMeta(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // Metadata is best-effort detail on a row that is itself the point.
    return null;
  }
}

function metaString(meta: Record<string, unknown> | null, key: string): string {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export type ActivityTimelineProps = {
  activities: RevenueActivity[];
  /** Company slug, for the `/c/:slug/mail/t/:threadId` deep links. */
  companySlug: string;
  /** `activityTotal` from the API — drives the "showing N of M" footer. */
  total?: number;
  emptyTitle?: string;
  emptyText?: string;
  /**
   * Optional `dealId → { title, to }` map. A contact's timeline carries
   * activities logged against their deals, and naming the deal is the
   * difference between "Discovery → Proposal" and a line nobody can place.
   */
  dealLinks?: Record<string, { title: string; to: string }>;
};

export function ActivityTimeline({
  activities,
  companySlug,
  total,
  emptyTitle = "Nothing has happened yet",
  emptyText = "Emails, meetings, deal moves and sequence touches all land here on their own — there is nothing to fill in by hand.",
  dealLinks,
}: ActivityTimelineProps) {
  const groups = React.useMemo(() => groupByDay(activities), [activities]);

  if (activities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {emptyTitle}
        </h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
          {emptyText}
        </p>
      </div>
    );
  }

  const shown = activities.length;
  const overall = total ?? shown;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      {groups.map((group, gi) => (
        <div key={`${group.key}-${gi}`}>
          <div className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-400">
            {group.label}
          </div>
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {group.items.map((activity) => (
              <TimelineRow
                key={activity.id}
                activity={activity}
                companySlug={companySlug}
                dealLinks={dealLinks}
              />
            ))}
          </ul>
        </div>
      ))}
      {overall > shown && (
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Showing the {shown} most recent of {overall} events.
        </div>
      )}
    </div>
  );
}

function TimelineRow({
  activity,
  companySlug,
  dealLinks,
}: {
  activity: RevenueActivity;
  companySlug: string;
  dealLinks?: Record<string, { title: string; to: string }>;
}) {
  const meta = KIND_META[activity.kind] ?? FALLBACK_META;
  const occurred = new Date(activity.occurredAt);
  const detail = parseMeta(activity.metaJson);
  const deal = activity.dealId ? dealLinks?.[activity.dealId] : undefined;
  const threadTo = activity.mailThreadId
    ? `/c/${companySlug}/mail/t/${activity.mailThreadId}`
    : null;
  const lostReason = metaString(detail, "lostReason");
  const signalName = metaString(detail, "signalName");
  const sequenceName = metaString(detail, "sequenceName");
  const footnote = lostReason
    ? `Reason: ${lostReason}`
    : signalName || sequenceName || "";

  return (
    <li className="flex gap-3 px-4 py-3 transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
      <span
        className={
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 " +
          meta.tone
        }
        aria-hidden="true"
      >
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {activity.subject || meta.label}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {meta.label}
          </span>
        </div>
        {activity.bodyText && (
          <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {activity.bodyText}
          </p>
        )}
        {footnote && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{footnote}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
          <span className="tabular-nums">
            {Number.isNaN(occurred.getTime()) ? "—" : timeLabel(occurred)}
          </span>
          {deal && (
            <Link
              to={deal.to}
              className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 hover:underline dark:text-slate-400 dark:hover:text-indigo-400"
            >
              <Briefcase size={11} />
              {deal.title}
            </Link>
          )}
          {threadTo && (
            <Link
              to={threadTo}
              className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <ExternalLink size={11} />
              Open thread
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
