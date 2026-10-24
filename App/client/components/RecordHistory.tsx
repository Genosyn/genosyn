import React from "react";
import { Link } from "react-router-dom";
import { Bot, CalendarClock, Clock, Cog, History, Webhook } from "lucide-react";
import { errorMessage } from "../lib/errors";
import {
  ACTOR_KIND_LABEL,
  describeHistoryAction,
  fetchRecordHistory,
  formatHistoryValue,
  historyDayLabel,
  historyTimeAgo,
  humanizeKey,
  type RecordHistoryEntry,
} from "../lib/recordHistory";
import { useLiveRefetch } from "./CompanySocket";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "./ui/Avatar";
import { FormError } from "./ui/FormError";
import { Spinner } from "./ui/Spinner";
import { clsx } from "./ui/clsx";

/**
 * A record's History, as a feed: who changed it — a Member, an AI Employee,
 * the Scheduler, a webhook — what they did, and when, newest first and
 * grouped by day. Every detail page mounts the same component with its own
 * `targetType`, so a routine, an invoice and a deal read the same way.
 *
 * Rows come from the audit ledger (`GET /history/:type/:id`), which records
 * who acted at the write seam. `milestones` covers what predates that: a
 * record's own timestamps (created, issued, paid) render as unattributed
 * entries only when no recorded entry already says the same thing.
 */

export type RecordHistoryMilestone = {
  /** Shown as the sentence — "Created", "Issued", "Paid". */
  label: string;
  at: string | null | undefined;
  /** Action suffixes that, when present in the feed, make this redundant. */
  covers: string[];
};

type FeedItem =
  | { kind: "entry"; at: string; entry: RecordHistoryEntry }
  | { kind: "milestone"; at: string; milestone: RecordHistoryMilestone };

export function RecordHistory({
  companyId,
  companySlug,
  targetType,
  targetId,
  noun,
  currency,
  milestones = [],
  title = "History",
  className,
}: {
  companyId: string;
  companySlug: string;
  targetType: string;
  targetId: string;
  /** How a sentence names the record: "this invoice", "this routine". */
  noun: string;
  /** Formats `*Cents` details as money. */
  currency?: string;
  milestones?: RecordHistoryMilestone[];
  title?: string;
  className?: string;
}) {
  const [items, setItems] = React.useState<RecordHistoryEntry[] | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const page = await fetchRecordHistory(companyId, targetType, targetId);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [companyId, targetType, targetId]);

  React.useEffect(() => {
    setItems(null);
    void reload();
  }, [reload]);

  // A change made anywhere — this tab, another Member, an AI Employee's Run —
  // lands as an audit row, so the feed follows it without a manual refresh.
  useLiveRefetch("audit", () => void reload());

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchRecordHistory(companyId, targetType, targetId, nextCursor);
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const feed = React.useMemo<FeedItem[]>(() => {
    const entries = items ?? [];
    const oldestLoaded = entries.length ? entries[entries.length - 1].createdAt : null;
    const out: FeedItem[] = entries.map((entry) => ({ kind: "entry", at: entry.createdAt, entry }));
    for (const m of milestones) {
      if (!m.at) continue;
      const covered = entries.some((e) => m.covers.some((suffix) => e.action.endsWith(suffix)));
      if (covered) continue;
      // While older pages remain, a milestone older than what is loaded may
      // yet be covered by a row on them; it waits until they are in.
      if (nextCursor && oldestLoaded && m.at < oldestLoaded) continue;
      out.push({ kind: "milestone", at: m.at, milestone: m });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [items, milestones, nextCursor]);

  const groups = React.useMemo(() => {
    const byDay: { label: string; items: FeedItem[] }[] = [];
    for (const item of feed) {
      const label = historyDayLabel(item.at);
      const last = byDay[byDay.length - 1];
      if (last && last.label === label) last.items.push(item);
      else byDay.push({ label, items: [item] });
    }
    return byDay;
  }, [feed]);

  return (
    <section
      className={clsx(
        "rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <History size={14} className="text-slate-400 dark:text-slate-500" />
        <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {title}
        </h3>
      </header>

      {error ? (
        <div className="mt-3">
          <FormError message={error} />
        </div>
      ) : items === null ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : feed.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          No changes recorded yet. Edits by Members and AI Employees will appear here.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="mb-2 text-[11px] font-medium text-slate-400 dark:text-slate-500">
                {group.label}
              </div>
              <ol className="relative">
                {group.items.map((item, i) => (
                  <li key={item.kind === "entry" ? item.entry.id : `m-${item.milestone.label}`}>
                    <div
                      className={clsx(
                        "relative flex gap-3",
                        i < group.items.length - 1 && "pb-4",
                      )}
                    >
                      {i < group.items.length - 1 && (
                        <span
                          aria-hidden
                          className="absolute left-[13px] top-8 bottom-0 w-px bg-slate-200 dark:bg-slate-700"
                        />
                      )}
                      {item.kind === "entry" ? (
                        <EntryRow
                          entry={item.entry}
                          companyId={companyId}
                          companySlug={companySlug}
                          targetType={targetType}
                          noun={noun}
                          currency={currency}
                        />
                      ) : (
                        <MilestoneRow milestone={item.milestone} at={item.at} />
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {nextCursor && (
            <button
              className="w-full rounded-lg border border-slate-200 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Show older changes"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ActorBadge({ kind }: { kind: RecordHistoryEntry["actorKind"] }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium",
        kind === "ai"
          ? "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
          : kind === "user"
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200"
            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
      )}
    >
      {kind === "ai" && <Bot size={10} />}
      {ACTOR_KIND_LABEL[kind]}
    </span>
  );
}

function ActorIcon({ entry, companyId }: { entry: RecordHistoryEntry; companyId: string }) {
  if (entry.actorKind === "ai") {
    const e = entry.actorEmployee;
    return (
      <Avatar
        size="sm"
        kind="ai"
        className="h-7 w-7"
        name={e?.name ?? "AI Employee"}
        src={e ? employeeAvatarUrl(companyId, e.id, e.avatarKey) : null}
      />
    );
  }
  if (entry.actorKind === "user") {
    const u = entry.actor;
    return (
      <Avatar
        size="sm"
        className="h-7 w-7"
        name={u?.name ?? "Member"}
        src={u ? memberAvatarUrl(companyId, u.id, u.avatarKey) : null}
      />
    );
  }
  const Icon = entry.actorKind === "cron" ? Clock : entry.actorKind === "webhook" ? Webhook : Cog;
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <Icon size={13} />
    </span>
  );
}

function EntryRow({
  entry,
  companyId,
  companySlug,
  targetType,
  noun,
  currency,
}: {
  entry: RecordHistoryEntry;
  companyId: string;
  companySlug: string;
  targetType: string;
  noun: string;
  currency?: string;
}) {
  const name =
    entry.actorKind === "ai"
      ? (entry.actorEmployee?.name ?? "An AI Employee")
      : entry.actorKind === "user"
        ? (entry.actor?.name ?? "A Member")
        : ACTOR_KIND_LABEL[entry.actorKind];
  const details = Object.entries(entry.details);
  const emp = entry.actorEmployee;
  return (
    <>
      <div className="relative z-10 shrink-0">
        <ActorIcon entry={entry} companyId={companyId} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
          {emp ? (
            <Link
              to={`/c/${companySlug}/employees/${emp.slug}`}
              className="font-medium text-slate-900 hover:underline dark:text-slate-100"
            >
              {name}
            </Link>
          ) : (
            <span className="font-medium text-slate-900 dark:text-slate-100">{name}</span>
          )}
          {(entry.actorKind === "ai" || entry.actorKind === "user") && (
            <ActorBadge kind={entry.actorKind} />
          )}
          <span className="text-slate-600 dark:text-slate-300">
            {describeHistoryAction(entry.action, targetType, noun)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500 dark:text-slate-400">
          <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>
            {historyTimeAgo(entry.createdAt)}
          </time>
          {emp?.role && <span>· {emp.role}</span>}
          {entry.runId && emp && (
            <>
              <span>·</span>
              <Link
                className="underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200"
                to={`/c/${companySlug}/employees/${emp.slug}/routines?run=${entry.runId}`}
              >
                during a Routine run
              </Link>
            </>
          )}
        </div>
        {entry.changedFields.length > 0 && (
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Changed {entry.changedFields.map(humanizeKey).join(", ")}
          </div>
        )}
        {details.length > 0 && (
          <dl className="mt-1.5 flex flex-wrap gap-1">
            {details.map(([key, value]) => (
              <div
                key={key}
                className="inline-flex max-w-full items-baseline gap-1 rounded-md bg-slate-50 px-1.5 py-0.5 text-xs dark:bg-slate-800/70"
              >
                <dt className="shrink-0 text-slate-400 dark:text-slate-500">{humanizeKey(key)}</dt>
                <dd className="truncate text-slate-700 dark:text-slate-200">
                  {formatHistoryValue(key, value, currency)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  );
}

function MilestoneRow({ milestone, at }: { milestone: RecordHistoryMilestone; at: string }) {
  return (
    <>
      <span className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <CalendarClock size={13} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-sm text-slate-700 dark:text-slate-200">{milestone.label}</div>
        <div
          className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
          title="Recorded before who made each change was kept"
        >
          {historyTimeAgo(at)}
        </div>
      </div>
    </>
  );
}
