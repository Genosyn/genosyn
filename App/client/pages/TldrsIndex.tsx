import React from "react";
import {
  AlertCircle,
  BookText,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  MessageSquare,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Link, useOutletContext } from "react-router-dom";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import { useLiveRefetch } from "@/components/CompanySocket";
import { TldrDiscussButton } from "@/components/tldrs/TldrDiscussButton";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { api, type TldrItem, type TldrListResponse, type TldrSettings } from "@/lib/api";
import { formatRelative } from "@/components/decisions/relative";
import type { TldrsOutletContext } from "@/pages/TldrsLayout";

type Filter = "unread" | "all";
type PageData = { list: TldrListResponse; settings: TldrSettings };

export default function TldrsIndex() {
  const { company } = useOutletContext<TldrsOutletContext>();
  const { background } = useToast();
  const [data, setData] = React.useState<PageData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>("unread");
  const [loadingMore, setLoadingMore] = React.useState(false);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const [list, settings] = await Promise.all([
        api.get<TldrListResponse>(`/api/companies/${company.id}/tldrs`),
        api.get<TldrSettings>(`/api/companies/${company.id}/tldrs/settings`),
      ]);
      setData({ list, settings });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load TLDRs.");
    }
  }, [company.id]);

  React.useEffect(() => {
    setData(null);
    setLoadingMore(false);
    void reload();
  }, [reload]);

  useLiveRefetch("tldr", reload);

  // Home links to a specific briefing. The card arrives after the fetch, so
  // scroll once the target has actually mounted rather than relying on the
  // browser's first, too-early hash pass.
  React.useEffect(() => {
    if (!data || !window.location.hash) return;
    const target = document.getElementById(window.location.hash.slice(1));
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [data]);

  function dismiss(item: TldrItem) {
    if (item.dismissed) return;
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        list: {
          ...current.list,
          unreadCount: Math.max(0, current.list.unreadCount - 1),
          items: current.list.items.map((row) =>
            row.id === item.id ? { ...row, dismissed: true } : row,
          ),
        },
      };
    });

    background(() => api.post(`/api/companies/${company.id}/tldrs/${item.id}/dismiss`), {
      loading: "Dismissing TLDR…",
      success: "TLDR dismissed",
      error: (err) =>
        `Couldn’t dismiss the TLDR: ${
          err instanceof Error ? err.message : "Unknown error"
        }. It has been restored.`,
      onError: () => {
        setData((current) => {
          if (!current) return current;
          const existing = current.list.items.find((row) => row.id === item.id);
          if (!existing?.dismissed) return current;
          return {
            ...current,
            list: {
              ...current.list,
              unreadCount: current.list.unreadCount + 1,
              items: current.list.items.map((row) =>
                row.id === item.id ? { ...row, dismissed: false } : row,
              ),
            },
          };
        });
      },
    });
  }

  async function loadMore() {
    const last = data?.list.items.at(-1);
    if (!data || !last || loadingMore || data.list.items.length >= data.list.total) return;
    setLoadingMore(true);
    setError(null);
    try {
      const before = encodeURIComponent(last.createdAt);
      const next = await api.get<TldrListResponse>(
        `/api/companies/${company.id}/tldrs?limit=30&before=${before}`,
      );
      setData((current) => {
        if (!current) return current;
        const known = new Set(current.list.items.map((item) => item.id));
        return {
          ...current,
          list: {
            total: next.total,
            unreadCount: next.unreadCount,
            items: [...current.list.items, ...next.items.filter((item) => !known.has(item.id))],
          },
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load older TLDRs.");
    } finally {
      setLoadingMore(false);
    }
  }

  const canManage = company.role !== "member";
  const shown = data?.list.items.filter((item) => filter === "all" || !item.dismissed) ?? [];
  const groups = groupByDay(shown);
  const base = `/c/${company.slug}/tldrs`;
  const hasMore = Boolean(data && data.list.items.length < data.list.total);
  const unloadedUnread = Math.max(0, (data?.list.unreadCount ?? 0) - shown.length);
  const isDefaultDraft = data?.settings.id === null;
  const needsWriter = Boolean(data?.settings.id && !data.settings.employeeId);

  return (
    <div className="page-shell px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section className="overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-sm dark:border-violet-500/25 dark:bg-slate-950">
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
              <Sparkles size={21} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  TLDRs
                </h1>
                {data && data.list.unreadCount > 0 && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                    {data.list.unreadCount} unread
                  </span>
                )}
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
                Short, periodic briefings on completed work and the conversations moving your
                company forward.
              </p>
              <p className="mt-2 flex max-w-2xl items-start gap-1.5 text-[11px] leading-5 text-slate-400 dark:text-slate-500">
                <ShieldCheck size={13} className="mt-0.5 shrink-0" />
                Only public Workspace channels, company-visible journal entries, and terminal
                Routine Run output are included. Private channels, DMs, and direct chats never are.
              </p>
            </div>
          </div>

          {data && (
            <div className="flex shrink-0 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
              <span
                className={
                  "h-2 w-2 rounded-full " +
                  (isDefaultDraft
                    ? "bg-violet-500"
                    : needsWriter
                      ? "bg-amber-500"
                      : data.settings.enabled
                        ? "bg-emerald-500"
                        : "bg-slate-300 dark:bg-slate-600")
                }
              />
              <div>
                <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                  {isDefaultDraft
                    ? "Daily briefings are ready"
                    : needsWriter
                      ? "A briefing AI Employee is needed"
                      : data.settings.enabled
                        ? "Briefings are on"
                        : "Briefings are paused"}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isDefaultDraft
                    ? canManage
                      ? "Choose or hire an AI Employee to start the schedule"
                      : "An owner or admin can choose the briefing writer"
                    : needsWriter
                      ? canManage
                        ? "Choose a connected AI Employee to resume briefings"
                        : "An owner or admin can resume briefings"
                      : data.settings.enabled && data.settings.nextRunAt
                        ? `Next ${formatRelative(data.settings.nextRunAt)}`
                        : data.settings.enabled
                          ? "The next interval is being scheduled"
                          : "No automatic TLDRs will be created"}
                </div>
              </div>
              <Link
                to={`${base}/settings`}
                className="ml-2 flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Settings <ChevronRight size={12} />
              </Link>
            </div>
          )}
        </div>
      </section>

      {error && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center dark:border-rose-500/25 dark:bg-rose-500/10">
          <AlertCircle size={18} className="shrink-0 text-rose-600 dark:text-rose-300" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-rose-800 dark:text-rose-200">
              Could not load TLDRs
            </div>
            <div className="mt-0.5 text-xs text-rose-700 dark:text-rose-300">{error}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {!data && !error ? (
        <div className="flex min-h-[45vh] items-center justify-center">
          <Spinner size={22} />
        </div>
      ) : data ? (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <FilterButton
              active={filter === "unread"}
              onClick={() => setFilter("unread")}
              label="Unread"
              count={data.list.unreadCount}
            />
            <FilterButton
              active={filter === "all"}
              onClick={() => setFilter("all")}
              label="All briefings"
              count={data.list.total}
            />
          </div>

          {shown.length === 0 ? (
            <div className="mt-4">
              {data.list.total === 0 ? (
                <EmptyState
                  title={
                    isDefaultDraft || needsWriter
                      ? canManage
                        ? "Choose a briefing AI Employee"
                        : "A briefing AI Employee is needed"
                      : data.settings.enabled
                        ? "Automatic briefings are on"
                        : "No TLDRs yet"
                  }
                  description={
                    isDefaultDraft
                      ? canManage
                        ? "Daily briefings are on by default. Choose or hire an AI Employee to start the schedule, then connect their AI Model before the first briefing is due."
                        : "Daily briefings are on by default. An owner or admin can choose the writer; the writer needs a connected AI Model before a briefing can run."
                      : needsWriter
                        ? canManage
                          ? "Choose a connected AI Employee to resume automatic briefings."
                          : "An owner or admin needs to choose a connected AI Employee before automatic briefings can resume."
                        : data.settings.enabled
                          ? data.settings.nextRunAt
                            ? `The next scheduled check is ${formatRelative(data.settings.nextRunAt)}. A TLDR appears here and on Home when the writer has a connected AI Model and the period contains useful activity.`
                            : "A TLDR will appear here and on Home once the writer has a connected AI Model and an interval contains useful activity."
                          : canManage
                            ? "Resume automatic briefings in Settings when you want new company activity summarized."
                            : "An owner or admin can resume automatic briefings."
                  }
                  action={
                    canManage ? (
                      <Link
                        to={`${base}/settings`}
                        className="inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 dark:bg-indigo-500 dark:hover:bg-indigo-600"
                      >
                        Configure TLDRs
                      </Link>
                    ) : undefined
                  }
                />
              ) : filter === "unread" && data.list.unreadCount > 0 && hasMore ? (
                <EmptyState
                  title="Older unread TLDRs are waiting"
                  description={`${data.list.unreadCount} unread ${data.list.unreadCount === 1 ? "briefing is" : "briefings are"} outside the newest page. Load older history to bring ${data.list.unreadCount === 1 ? "it" : "them"} into view.`}
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                    >
                      {loadingMore ? <Spinner size={14} /> : null}
                      {loadingMore ? "Loading…" : "Find older unread TLDRs"}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="You're all caught up"
                  description="Every TLDR has been dismissed from your Home queue. The full history is still here whenever you need it."
                  action={
                    <Button variant="secondary" onClick={() => setFilter("all")}>
                      View history
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <div className="mt-5 space-y-8">
              {groups.map(([day, items]) => (
                <section key={day}>
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    <CalendarClock size={12} /> {formatDayHeading(day)}
                  </div>
                  <div className="space-y-3">
                    {items.map((item) => (
                      <TldrCard key={item.id} company={company} item={item} onDismiss={dismiss} />
                    ))}
                  </div>
                </section>
              ))}
              {hasMore && (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="secondary"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? <Spinner size={14} /> : null}
                    {loadingMore
                      ? "Loading older TLDRs…"
                      : filter === "unread" && unloadedUnread > 0
                        ? `Load older briefings · ${unloadedUnread} unread remaining`
                        : `Load older briefings · ${data.list.items.length} of ${data.list.total}`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
        (active
          ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {label}
      <span className="tabular-nums text-slate-400 dark:text-slate-500">{count}</span>
    </button>
  );
}

function TldrCard({
  company,
  item,
  onDismiss,
}: {
  company: TldrsOutletContext["company"];
  item: TldrItem;
  onDismiss: (item: TldrItem) => void;
}) {
  const employee = item.employee;
  const avatar = employee.id
    ? employeeAvatarUrl(company.id, employee.id, employee.avatarKey)
    : null;
  const body = item.body.trim();
  const summary = item.summary.trim();

  return (
    <article
      id={`tldr-${item.id}`}
      className="scroll-mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-colors dark:border-slate-800 dark:bg-slate-950"
    >
      <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={employee.name || "AI Employee"} src={avatar} kind="ai" size="md" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {item.title || "Company TLDR"}
              </h2>
              {!item.dismissed && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" title="Unread" />
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span>{employee.name || "AI Employee"}</span>
              <span aria-hidden="true">·</span>
              <span
                title={`${new Date(item.periodStart).toLocaleString()} – ${new Date(item.periodEnd).toLocaleString()}`}
              >
                {formatPeriod(item.periodStart, item.periodEnd)}
              </span>
              <span aria-hidden="true">·</span>
              <span title={new Date(item.createdAt).toLocaleString()}>
                created {formatRelative(item.createdAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
          <TldrDiscussButton company={company} item={item} compact />
          {item.triggerKind === "manual" && (
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              Generated manually
            </span>
          )}
          {item.dismissed ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              <CheckCircle2 size={11} /> Read
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onDismiss(item)}>
              <Check size={14} /> Dismiss
            </Button>
          )}
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        {summary && (
          <p className="text-[15px] font-medium leading-6 text-slate-800 dark:text-slate-200">
            {summary}
          </p>
        )}
        {body && body !== summary && (
          <div
            className={
              summary
                ? "mt-3 text-sm leading-6 text-slate-700 dark:text-slate-300"
                : "text-sm leading-6 text-slate-700 dark:text-slate-300"
            }
          >
            <ChatMarkdown content={body} />
          </div>
        )}

        <SourceStats item={item} />
      </div>
    </article>
  );
}

function SourceStats({ item }: { item: TldrItem }) {
  const stats = item.sourceStats;
  const entries: Array<{ key: string; label: string; icon: React.ReactNode }> = [];
  if (stats.journalEntries > 0) {
    entries.push({
      key: "journal",
      label: `${stats.journalEntries} journal ${stats.journalEntries === 1 ? "entry" : "entries"}`,
      icon: <BookText size={12} />,
    });
  }
  if (stats.routineRuns > 0) {
    entries.push({
      key: "runs",
      label: `${stats.routineRuns} Routine ${stats.routineRuns === 1 ? "run" : "runs"}`,
      icon: <Play size={12} />,
    });
  }
  if (stats.channelMessages > 0) {
    entries.push({
      key: "messages",
      label: `${stats.channelMessages} ${stats.channelMessages === 1 ? "message" : "messages"} in ${stats.channels} ${stats.channels === 1 ? "channel" : "channels"}`,
      icon: <MessageSquare size={12} />,
    });
  }
  if (entries.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
      {entries.map((entry) => (
        <span
          key={entry.key}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-500 dark:bg-slate-900 dark:text-slate-400"
        >
          {entry.icon} {entry.label}
        </span>
      ))}
    </div>
  );
}

function groupByDay(items: TldrItem[]): Array<[string, TldrItem[]]> {
  const groups = new Map<string, TldrItem[]>();
  for (const item of items) {
    const date = new Date(item.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()];
}

function formatDayHeading(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function formatPeriod(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const time = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (start.toDateString() === end.toDateString()) {
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(start)}–${time(end)}`;
  }
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
