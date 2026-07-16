import React from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  AtSign,
  BellRing,
  Calendar,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ListChecks,
  Mail,
  MessageSquare,
  NotebookPen,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
// The API's Notification row is aliased so the DOM global `Notification`
// (used for the push-permission check) stays reachable in value positions.
import {
  api,
  Company,
  HomeApproval,
  HomeChannel,
  HomeData,
  HomeFailedRun,
  HomeTodo,
  HealthSeverity,
  Me,
  Notification as NotificationRow,
  NotificationKind,
  TodoPriority,
} from "../lib/api";
import {
  ContextualLayout,
  SECTION_GROUPS,
  SectionItem,
} from "../components/AppShell";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "../components/ui/Avatar";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { useCompanySocketSubscription } from "../components/CompanySocket";
import { enablePush, pushSupported } from "../lib/push";
import { clsx } from "../components/ui/clsx";

/**
 * Home — the landing page after sign-in. One aggregation call
 * (`GET /api/companies/:cid/home`) fills the cards: unread notifications,
 * todos assigned to me, reviews waiting on my sign-off, pending approvals,
 * unread channels, and today's AI activity. Every card deep-links into the
 * full section; the bottom grid is a section directory for navigation.
 */

const PUSH_PROMPT_DISMISSED_KEY = "genosyn.pushPromptDismissed";

export default function HomePage({
  company,
  me,
}: {
  company: Company;
  me: Me;
}) {
  const [data, setData] = React.useState<HomeData | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<HomeData>(`/api/companies/${company.id}/home`);
      setData(d);
    } catch {
      // Keep whatever we had; transient fetch errors shouldn't blank the page.
    }
  }, [company.id]);

  React.useEffect(() => {
    setData(null);
    reload();
  }, [reload]);

  // Live-refresh when something lands in my bell, and on tab focus so the
  // page is current when the user comes back to it.
  useCompanySocketSubscription((ev) => {
    if (
      (ev.type === "notification.new" || ev.type === "notification.read") &&
      ev.userId === me.id
    ) {
      reload();
    }
  });
  React.useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  return (
    <ContextualLayout>
      <div className="mx-auto max-w-6xl px-6 py-8 lg:px-8">
        <Greeting me={me} company={company} />
        <PushPromptBanner />
        {data === null ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <Spinner size={22} />
          </div>
        ) : (
          <>
            <FailedRoutinesAlert company={company} data={data} onDismissed={reload} />
            <StatStrip company={company} data={data} />
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <AttentionCard company={company} data={data} onChanged={reload} />
              <SystemHealthCard company={company} data={data} />
              <MyTodosCard company={company} data={data} />
              <MessagesCard company={company} data={data} />
              <ReviewsCard company={company} data={data} />
              <ApprovalsCard company={company} data={data} />
              <ActivityCard company={company} data={data} />
            </div>
            <JumpTo company={company} />
          </>
        )}
      </div>
    </ContextualLayout>
  );
}

// ───────────────────────── header ────────────────────────────────────────────

function Greeting({ me, company }: { me: Me; company: Company }) {
  const hour = new Date().getHours();
  const salute =
    hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (me.name || me.email).split(/[\s@]/)[0];
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        {salute}, {firstName}
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {today} · Here&apos;s what needs your attention at {company.name}.
      </p>
    </div>
  );
}

// ───────────────────────── push prompt ───────────────────────────────────────

function PushPromptBanner() {
  const { toast } = useToast();
  const [visible, setVisible] = React.useState(
    () =>
      pushSupported() &&
      Notification.permission === "default" &&
      localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY) !== "1",
  );
  const [busy, setBusy] = React.useState(false);
  if (!visible) return null;

  async function enable() {
    setBusy(true);
    try {
      await enablePush();
      toast("Push notifications enabled on this device.", "success");
      setVisible(false);
    } catch (err) {
      toast((err as Error).message, "error");
      if (Notification.permission === "denied") setVisible(false);
    } finally {
      setBusy(false);
    }
  }
  function dismiss() {
    localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, "1");
    setVisible(false);
  }

  return (
    <div className="mt-5 flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 dark:border-indigo-500/30 dark:bg-indigo-500/10">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300">
        <BellRing size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Get notified when something needs you
        </div>
        <div className="text-xs text-slate-600 dark:text-slate-400">
          Mentions, review requests, and approvals arrive as push notifications
          — even when Genosyn is closed.
        </div>
      </div>
      <Button size="sm" onClick={enable} disabled={busy}>
        {busy ? "Enabling…" : "Enable"}
      </Button>
      <button
        onClick={dismiss}
        className="rounded p-1 text-slate-400 hover:bg-indigo-100 hover:text-slate-700 dark:hover:bg-indigo-500/20 dark:hover:text-slate-200"
        title="Not now"
        aria-label="Dismiss"
      >
        <X size={15} />
      </button>
    </div>
  );
}

// ───────────────────────── stat strip ────────────────────────────────────────

function StatStrip({ company, data }: { company: Company; data: HomeData }) {
  const stats: {
    label: string;
    value: number;
    icon: React.ReactNode;
    to: string;
    accent: string;
  }[] = [
    {
      label: "Unread notifications",
      value: data.unreadNotificationCount,
      icon: <AtSign size={15} />,
      to: `/c/${company.slug}`,
      accent: "text-rose-600 bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300",
    },
    {
      label: "Todos assigned to you",
      value: data.myTodoCount,
      icon: <ListChecks size={15} />,
      to: `/c/${company.slug}/tasks`,
      accent:
        "text-indigo-600 bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300",
    },
    {
      label: "Reviews waiting on you",
      value: data.reviewTodoCount,
      icon: <ClipboardCheck size={15} />,
      to: `/c/${company.slug}/tasks/review`,
      accent:
        "text-violet-600 bg-violet-100 dark:bg-violet-500/15 dark:text-violet-300",
    },
    {
      label: "Pending approvals",
      value: data.pendingApprovalCount,
      icon: <ShieldCheck size={15} />,
      to: `/c/${company.slug}/approvals`,
      accent:
        "text-amber-600 bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300",
    },
  ];
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <Link
          key={s.label}
          to={s.to}
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
        >
          <span
            className={clsx(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              s.accent,
            )}
          >
            {s.icon}
          </span>
          <span className="min-w-0">
            <span className="block text-lg font-semibold tabular-nums leading-tight text-slate-900 dark:text-slate-100">
              {s.value}
            </span>
            <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
              {s.label}
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}

// ───────────────────────── failed routines alert ─────────────────────────────

function failedRunLink(company: Company, r: HomeFailedRun): string {
  const params = new URLSearchParams({ routine: r.routineId, run: r.runId });
  // The rollup knows a routine id but not its slug; the Routines index resolves
  // the id and forwards to that run's history.
  return `/c/${company.slug}/routines?${params.toString()}`;
}

function failedRunBadge(r: HomeFailedRun): string {
  if (r.status === "timeout") return "timeout";
  return r.exitCode !== null ? `exit ${r.exitCode}` : "failed";
}

/**
 * High-visibility alert listing routine runs that failed in the last 24h.
 * Only renders when something is broken — a clean day shows nothing here.
 * Each row deep-links into the routine's run history (on the failing run).
 */
function FailedRoutinesAlert({
  company,
  data,
  onDismissed,
}: {
  company: Company;
  data: HomeData;
  /** Refetch Home data after a run is dismissed so the panel updates. */
  onDismissed: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [dismissing, setDismissing] = React.useState<string | null>(null);

  async function dismiss(runId: string) {
    setDismissing(runId);
    try {
      await api.post(`/api/companies/${company.id}/runs/${runId}/dismiss`);
      await onDismissed();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setDismissing(null);
    }
  }

  if (data.failedRuns.length === 0) return null;
  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-rose-200 bg-rose-50/60 shadow-sm dark:border-rose-500/30 dark:bg-rose-500/10">
      <div className="flex items-center gap-2 border-b border-rose-200/70 px-4 py-3 dark:border-rose-500/20">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300">
          <AlertTriangle size={15} />
        </span>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Failed routines
        </h2>
        <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold tabular-nums text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
          {data.failedRunCount}
        </span>
        <Link
          to={`/c/${company.slug}/inbox`}
          className="ml-auto flex items-center gap-0.5 text-xs text-rose-700 hover:underline dark:text-rose-300"
        >
          Journal <ChevronRight size={12} />
        </Link>
      </div>
      <ul className="divide-y divide-rose-100 dark:divide-rose-500/15">
        {data.failedRuns.map((r) => (
          <li key={r.runId} className="flex items-stretch">
            <Link
              to={failedRunLink(company, r)}
              className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 hover:bg-rose-100/50 dark:hover:bg-rose-500/10"
            >
              <Avatar
                name={r.employee.name}
                kind="ai"
                size="sm"
                src={employeeAvatarUrl(
                  company.id,
                  r.employee.id,
                  r.employee.avatarKey,
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {r.routineName}
                </span>
                <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {r.employee.name} · {formatRelative(r.startedAt)}
                </span>
              </span>
              <span className="shrink-0 rounded border border-rose-200 bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300">
                {failedRunBadge(r)}
              </span>
            </Link>
            <button
              type="button"
              onClick={() => dismiss(r.runId)}
              disabled={dismissing === r.runId}
              title="Dismiss"
              aria-label={`Dismiss ${r.routineName} failure`}
              className="flex shrink-0 items-center px-3 text-rose-400 transition hover:bg-rose-100/50 hover:text-rose-700 disabled:opacity-50 dark:text-rose-500/70 dark:hover:bg-rose-500/10 dark:hover:text-rose-200"
            >
              {dismissing === r.runId ? (
                <Spinner size={14} />
              ) : (
                <X size={15} />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────── shared card chrome ─────────────────────────────────

function HomeCard({
  title,
  icon,
  count,
  linkTo,
  linkLabel,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  linkTo: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="text-slate-400 dark:text-slate-500">{icon}</span>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {count}
          </span>
        )}
        <Link
          to={linkTo}
          className="ml-auto flex items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {linkLabel} <ChevronRight size={12} />
        </Link>
      </div>
      <div className="min-h-[8rem] flex-1">{children}</div>
    </section>
  );
}

function CardEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-1.5 px-6 py-6 text-center">
      <CheckCircle2 size={18} className="text-emerald-500 dark:text-emerald-400" />
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
    </div>
  );
}

// ───────────────────────── notifications card ────────────────────────────────

function AttentionCard({
  company,
  data,
  onChanged,
}: {
  company: Company;
  data: HomeData;
  onChanged: () => void;
}) {
  const navigate = useNavigate();

  async function open(n: NotificationRow) {
    try {
      await api.post(`/api/companies/${company.id}/notifications/mark-read`, {
        notificationId: n.id,
      });
    } catch {
      // Navigation wins even if the read flag failed to persist.
    }
    onChanged();
    if (n.link) navigate(n.link);
  }

  return (
    <HomeCard
      title="Needs your attention"
      icon={<AtSign size={15} />}
      count={data.unreadNotificationCount}
      linkTo={`/c/${company.slug}`}
      linkLabel="Bell has history"
    >
      {data.notifications.length === 0 ? (
        <CardEmpty label="You're all caught up — new mentions, reviews, and approvals land here." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.notifications.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => open(n)}
                className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <NotificationAvatar company={company} n={n} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                    {n.title}
                  </span>
                  <span className="block text-[11px] text-slate-400 dark:text-slate-500">
                    {formatRelative(n.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

function NotificationAvatar({
  company,
  n,
}: {
  company: Company;
  n: NotificationRow;
}) {
  const tone = KIND_TONE[n.kind] ?? KIND_TONE.mention;
  const actor = n.actor;
  const src = actor
    ? actor.kind === "user" && actor.id
      ? memberAvatarUrl(company.id, actor.id, actor.avatarKey)
      : actor.kind === "ai" && actor.id
        ? employeeAvatarUrl(company.id, actor.id, actor.avatarKey)
        : null
    : null;
  if (actor) {
    return (
      <Avatar
        name={actor.name}
        src={src}
        kind={actor.kind === "ai" ? "ai" : "human"}
        size="sm"
      />
    );
  }
  return (
    <span
      className={clsx(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
        tone.bg,
      )}
    >
      <KindIcon kind={n.kind} className={tone.fg} />
    </span>
  );
}

function KindIcon({
  kind,
  className,
}: {
  kind: NotificationKind;
  className?: string;
}) {
  switch (kind) {
    case "mention":
      return <AtSign size={12} className={className} />;
    case "todo_review_requested":
      return <ClipboardCheck size={12} className={className} />;
    case "approval_pending":
      return <ShieldCheck size={12} className={className} />;
    case "mail_handover":
      return <Mail size={12} className={className} />;
  }
}

const KIND_TONE: Record<NotificationKind, { bg: string; fg: string }> = {
  mention: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    fg: "text-rose-600 dark:text-rose-300",
  },
  todo_review_requested: {
    bg: "bg-violet-100 dark:bg-violet-500/15",
    fg: "text-violet-600 dark:text-violet-300",
  },
  approval_pending: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    fg: "text-amber-600 dark:text-amber-300",
  },
  mail_handover: {
    bg: "bg-sky-100 dark:bg-sky-500/15",
    fg: "text-sky-600 dark:text-sky-300",
  },
};

// ───────────────────────── todos / reviews cards ─────────────────────────────

const PRIORITY_DOT: Record<TodoPriority, string> = {
  none: "bg-slate-300 dark:bg-slate-600",
  low: "bg-slate-400",
  medium: "bg-amber-400",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};

function TodoList({
  company,
  todos,
}: {
  company: Company;
  todos: HomeTodo[];
}) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {todos.map((t) => {
        const due = formatDue(t.dueAt);
        return (
          <li key={t.id}>
            <Link
              to={`/c/${company.slug}/tasks/p/${t.project.slug}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
            >
              <span
                className={clsx(
                  "h-2 w-2 shrink-0 rounded-full",
                  PRIORITY_DOT[t.priority],
                )}
                title={`Priority: ${t.priority}`}
              />
              <span className="w-16 shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {t.project.key}-{t.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-900 dark:text-slate-100">
                {t.title}
              </span>
              {due && (
                <span
                  className={clsx(
                    "flex shrink-0 items-center gap-1 text-[11px]",
                    due.cls,
                  )}
                >
                  <Calendar size={11} /> {due.label}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function MyTodosCard({ company, data }: { company: Company; data: HomeData }) {
  return (
    <HomeCard
      title="Your todos"
      icon={<ListChecks size={15} />}
      count={data.myTodoCount}
      linkTo={`/c/${company.slug}/tasks`}
      linkLabel="All tasks"
    >
      {data.myTodos.length === 0 ? (
        <CardEmpty
          label={
            data.counts.projects === 0
              ? "No projects yet — create one under Tasks to start tracking work."
              : "Nothing assigned to you right now."
          }
        />
      ) : (
        <TodoList company={company} todos={data.myTodos} />
      )}
    </HomeCard>
  );
}

function ReviewsCard({ company, data }: { company: Company; data: HomeData }) {
  return (
    <HomeCard
      title="Reviews waiting on you"
      icon={<ClipboardCheck size={15} />}
      count={data.reviewTodoCount}
      linkTo={`/c/${company.slug}/tasks/review`}
      linkLabel="Review queue"
    >
      {data.reviewTodos.length === 0 ? (
        <CardEmpty label="No todos are waiting for your sign-off." />
      ) : (
        <TodoList company={company} todos={data.reviewTodos} />
      )}
    </HomeCard>
  );
}

// ───────────────────────── messages card ─────────────────────────────────────

function MessagesCard({ company, data }: { company: Company; data: HomeData }) {
  return (
    <HomeCard
      title="Unread messages"
      icon={<MessageSquare size={15} />}
      count={data.unreadChannels.reduce((sum, c) => sum + c.unreadCount, 0)}
      linkTo={`/c/${company.slug}/workspace`}
      linkLabel="Workspace"
    >
      {data.unreadChannels.length === 0 ? (
        <CardEmpty label="No unread channels or DMs." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.unreadChannels.map((c: HomeChannel) => (
            <li key={c.id}>
              <Link
                to={`/c/${company.slug}/workspace/${c.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                  <MessageSquare size={12} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-900 dark:text-slate-100">
                  {c.label}
                </span>
                <span className="shrink-0 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-white">
                  {c.unreadCount > 99 ? "99+" : c.unreadCount}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

// ───────────────────────── approvals card ────────────────────────────────────

function ApprovalsCard({ company, data }: { company: Company; data: HomeData }) {
  return (
    <HomeCard
      title="Pending approvals"
      icon={<ShieldCheck size={15} />}
      count={data.pendingApprovalCount}
      linkTo={`/c/${company.slug}/approvals`}
      linkLabel="Approvals"
    >
      {data.approvals.length === 0 ? (
        <CardEmpty label="Nothing is waiting on a human decision." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.approvals.map((a: HomeApproval) => (
            <li key={a.id}>
              <Link
                to={`/c/${company.slug}/approvals`}
                className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
                  <ShieldCheck size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                    {a.title ||
                      (a.routine
                        ? `Run "${a.routine.name}"`
                        : "Approval requested")}
                  </span>
                  <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">
                    {a.employee ? `${a.employee.name} · ` : ""}
                    {formatRelative(a.requestedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

// ───────────────────────── activity card ─────────────────────────────────────

function ActivityCard({ company, data }: { company: Company; data: HomeData }) {
  const { entries, employees } = data.journalToday;
  return (
    <HomeCard
      title="Today's AI activity"
      icon={<NotebookPen size={15} />}
      linkTo={`/c/${company.slug}/inbox`}
      linkLabel="Journal"
    >
      {data.counts.employees === 0 ? (
        <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 px-6 py-6 text-center">
          <Sparkles size={18} className="text-violet-500 dark:text-violet-400" />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            No AI employees yet — hire your first to put the company on
            autopilot.
          </span>
          <Link
            to={`/c/${company.slug}/employees/new`}
            className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Create an AI employee
          </Link>
        </div>
      ) : entries === 0 ? (
        <CardEmpty label="No journal entries yet today — runs and notes will show up here." />
      ) : (
        <div className="flex h-full min-h-[8rem] items-center gap-4 px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300">
            <NotebookPen size={18} />
          </span>
          <div>
            <div className="text-sm text-slate-900 dark:text-slate-100">
              <b className="tabular-nums">{entries}</b> journal{" "}
              {entries === 1 ? "entry" : "entries"} from{" "}
              <b className="tabular-nums">{employees}</b>{" "}
              {employees === 1 ? "employee" : "employees"} today
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              The Journal rolls up everything your AI team did, day by day.
            </div>
          </div>
        </div>
      )}
    </HomeCard>
  );
}

// ───────────────────────── system health card ────────────────────────────────

const HEALTH_DOT: Record<HealthSeverity, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-rose-500",
};

// Dismissals are remembered per-company in localStorage (a personal "I've seen
// this" on this device, like the push prompt above). We store the issue count
// at dismiss time so a check resurfaces only when it gets *worse*.
const HEALTH_DISMISS_PREFIX = "genosyn.systemHealth.dismissed.";

function loadHealthDismissed(companyId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(HEALTH_DISMISS_PREFIX + companyId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveHealthDismissed(companyId: string, map: Record<string, number>) {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(HEALTH_DISMISS_PREFIX + companyId);
    } else {
      localStorage.setItem(
        HEALTH_DISMISS_PREFIX + companyId,
        JSON.stringify(map),
      );
    }
  } catch {
    // localStorage may be unavailable (private mode) — dismissals just won't
    // persist across reloads, which is an acceptable degradation.
  }
}

function SystemHealthCard({
  company,
  data,
}: {
  company: Company;
  data: HomeData;
}) {
  const failing = data.systemHealth.checks.filter((c) => c.severity !== "ok");
  const failingKey = failing
    .map((c) => c.id)
    .sort()
    .join(",");

  const [dismissed, setDismissed] = React.useState<Record<string, number>>(() =>
    loadHealthDismissed(company.id),
  );

  // Re-sync from storage when the company or the set of failing checks changes,
  // dropping dismissals for checks that have since recovered — so a brand-new
  // occurrence resurfaces instead of staying hidden under a stale count.
  React.useEffect(() => {
    const stored = loadHealthDismissed(company.id);
    const live = new Set(failing.map((c) => c.id));
    const pruned: Record<string, number> = {};
    for (const [id, count] of Object.entries(stored)) {
      if (live.has(id)) pruned[id] = count;
    }
    if (Object.keys(pruned).length !== Object.keys(stored).length) {
      saveHealthDismissed(company.id, pruned);
    }
    setDismissed(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, failingKey]);

  function dismiss(checkId: string, count: number) {
    setDismissed((prev) => {
      const next = { ...prev, [checkId]: count };
      saveHealthDismissed(company.id, next);
      return next;
    });
  }

  function restoreAll() {
    saveHealthDismissed(company.id, {});
    setDismissed({});
  }

  // Show a check unless it's been dismissed at a count >= its current one
  // (i.e. nothing new has happened since you dismissed it).
  const visible = failing.filter(
    (c) => !(c.id in dismissed) || c.count > dismissed[c.id],
  );
  const dismissedCount = failing.length - visible.length;

  return (
    <HomeCard
      title="System health"
      icon={<Activity size={15} />}
      count={visible.length}
      linkTo={`/c/${company.slug}/settings/system-health`}
      linkLabel="Details"
    >
      {failing.length === 0 ? (
        <CardEmpty label="All systems healthy — routines, models, and integrations are running clean." />
      ) : visible.length === 0 ? (
        <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-1.5 px-6 py-6 text-center">
          <CheckCircle2 size={18} className="text-slate-400 dark:text-slate-500" />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {dismissedCount} {dismissedCount === 1 ? "issue" : "issues"} dismissed
            on this device.
          </span>
          <button
            type="button"
            onClick={restoreAll}
            className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Show {dismissedCount === 1 ? "it" : "them"}
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map((c) => (
            <li key={c.id} className="flex items-center">
              <Link
                to={`/c/${company.slug}/settings/system-health`}
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <span
                  className={clsx(
                    "h-2 w-2 shrink-0 rounded-full",
                    HEALTH_DOT[c.severity],
                  )}
                  title={c.severity}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-900 dark:text-slate-100">
                  {c.title}
                </span>
                <span
                  className={clsx(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                    c.severity === "error"
                      ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
                  )}
                >
                  {c.count}
                </span>
              </Link>
              <button
                type="button"
                onClick={() => dismiss(c.id, c.count)}
                className="mr-2 shrink-0 rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                title="Dismiss"
                aria-label={`Dismiss ${c.title}`}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

// ───────────────────────── jump-to directory ─────────────────────────────────

function JumpTo({ company }: { company: Company }) {
  const items: SectionItem[] = SECTION_GROUPS.flatMap((g) => g.items).filter(
    (i) => i.key !== "home",
  );
  return (
    <div className="mt-8">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Jump to
      </h2>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              to={`/c/${company.slug}${item.path}`}
              className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm transition-colors hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
            >
              <span
                className={clsx(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  item.iconBg,
                )}
              >
                <Icon size={15} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {item.label}
                </span>
                <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {item.description}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── tiny formatters ───────────────────────────────────

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

function formatDue(iso: string | null): { label: string; cls: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const month = d.toLocaleString("en-US", { month: "short", day: "numeric" });
  if (days < 0) return { label: month, cls: "text-red-600 dark:text-red-400" };
  if (days === 0) return { label: "Today", cls: "text-amber-600 dark:text-amber-400" };
  if (days === 1)
    return { label: "Tomorrow", cls: "text-amber-600 dark:text-amber-400" };
  return { label: month, cls: "text-slate-500 dark:text-slate-400" };
}
