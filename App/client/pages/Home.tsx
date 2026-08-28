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
  GitBranch,
  GitPullRequest,
  Hourglass,
  Landmark,
  Lightbulb,
  ListChecks,
  Mail,
  MessageSquare,
  PiggyBank,
  Play,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
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
  TldrItem,
  TodoPriority,
} from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { DecisionCard } from "../components/decisions/DecisionCard";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "../components/ui/Avatar";
import { Spinner } from "../components/ui/Spinner";
import { Button, buttonClassName } from "../components/ui/Button";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { useCompanySocketSubscription, useLiveRefetch } from "../components/CompanySocket";
import { SetupBanner } from "../components/SetupBanner";
import { errorMessage } from "../lib/errors";
import { enablePush, pushSupported } from "../lib/push";
import { clsx } from "../components/ui/clsx";

/**
 * Home — the landing page after sign-in. One aggregation call
 * (`GET /api/companies/:cid/home`) fills the cards: unread notifications,
 * todos assigned to me, reviews waiting on my sign-off, pending approvals,
 * and unread channels. Every card deep-links into the full section.
 *
 * **Every panel here hides itself when it has nothing.** Each one is a queue,
 * and an empty queue is not news — a card that spends a grid slot to say
 * "nothing is waiting on you" pushes the things that *are* waiting further
 * down, and six of them turn a quiet day into a wall of reassurance nobody
 * reads. The decision stack and the failure alert have always worked this way;
 * the rest now match. When every panel is empty {@link AllClear} says it once.
 */

const PUSH_PROMPT_DISMISSED_KEY = "genosyn.pushPromptDismissed";

export default function HomePage({ company, me }: { company: Company; me: Me }) {
  const [data, setData] = React.useState<HomeData | null>(null);
  const background = useBackgroundAction();

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
  // The stack is the first thing on the page, so it has to be current: a
  // teammate answering in another tab should empty it here without a refresh.
  // `tldr_question` keeps the Discuss badge honest — a card asked from the
  // TLDRs page changes this count without touching the briefing row.
  useLiveRefetch(["decision", "tldr", "tldr_question"], reload);

  function dismissTldr(item: TldrItem) {
    const originalIndex = data?.tldrs.findIndex((row) => row.id === item.id) ?? -1;
    setData((current) =>
      current
        ? {
            ...current,
            tldrs: current.tldrs.filter((row) => row.id !== item.id),
            unreadTldrCount: Math.max(0, current.unreadTldrCount - 1),
          }
        : current,
    );

    background(() => api.post(`/api/companies/${company.id}/tldrs/${item.id}/dismiss`), {
      title: "Couldn’t dismiss the TLDR",
      error: (err) => `${errorMessage(err)} It has been restored.`,
      onSuccess: () => void reload(),
      onError: () => {
        setData((current) => {
          if (!current || current.tldrs.some((row) => row.id === item.id)) return current;
          const restored = [...current.tldrs];
          restored.splice(Math.max(0, Math.min(originalIndex, restored.length)), 0, item);
          return {
            ...current,
            tldrs: restored,
            unreadTldrCount: current.unreadTldrCount + 1,
          };
        });
      },
    });
  }

  return (
    <ContextualLayout>
      <div className="page-shell px-6 py-8 lg:px-8">
        <Greeting me={me} company={company} />
        <SetupBanner company={company} />
        <PushPromptBanner />
        {data === null ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <Spinner size={22} />
          </div>
        ) : hasAnythingToShow(data) ? (
          <>
            <DecisionStack company={company} data={data} onResolved={reload} />
            <FailedRoutinesAlert company={company} data={data} onChanged={reload} />
            <HomeTldrPanel company={company} data={data} onDismiss={dismissTldr} />
            <StatStrip company={company} data={data} />
            {/* `empty:hidden` so the grid's own top margin goes away too on a
                day when every card inside it has hidden itself. */}
            <div className="mt-4 grid grid-cols-1 gap-4 empty:hidden lg:grid-cols-2">
              <AttentionCard company={company} data={data} onChanged={reload} />
              <SystemHealthCard company={company} data={data} />
              <MyTodosCard company={company} data={data} />
              <MessagesCard company={company} data={data} />
              <ReviewsCard company={company} data={data} />
              <ApprovalsCard company={company} data={data} />
            </div>
          </>
        ) : (
          <AllClear company={company} data={data} />
        )}
      </div>
    </ContextualLayout>
  );
}

// ───────────────────────── visibility ────────────────────────────────────────

/**
 * True when at least one panel below has something in it.
 *
 * These predicates are the same conditions the panels themselves guard on, in
 * the same order they render. Keep them in step: a panel that renders while
 * this returns `false` would sit under the all-clear message contradicting it.
 *
 * System health is the one that isn't a row count. A check the viewer dismissed
 * on this device still counts as visible, because the card stays up to offer it
 * back — {@link SystemHealthCard} owns that distinction and only disappears
 * when nothing is failing at all.
 */
function hasAnythingToShow(data: HomeData): boolean {
  return (
    data.decisions.length > 0 ||
    data.failedRuns.length > 0 ||
    data.tldrs.length > 0 ||
    statTotal(data) > 0 ||
    data.notifications.length > 0 ||
    data.myTodos.length > 0 ||
    data.reviewTodos.length > 0 ||
    data.unreadChannels.length > 0 ||
    data.approvals.length > 0 ||
    data.systemHealth.checks.some((c) => c.severity !== "ok")
  );
}

/**
 * What Home shows on a day when nothing needs a human.
 *
 * Hiding the empty panels leaves a greeting over blank space, which reads as a
 * page that failed to load rather than one with nothing to report. This says
 * the quiet part once, in the space six empty cards used to take.
 *
 * It also carries the one thing those empty cards were genuinely useful for: a
 * company with no Projects has nowhere for todos to come from, so point at
 * Tasks rather than telling them their empty queue is empty.
 */
function AllClear({ company, data }: { company: Company; data: HomeData }) {
  const noProjects = data.counts.projects === 0;
  return (
    <section className="mt-6 flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-16 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
        <CheckCircle2 size={20} />
      </span>
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Nothing needs you right now
      </h2>
      <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
        Decisions your AI employees stack, failed routines, mentions, todos, and approvals appear
        here the moment they arrive.
      </p>
      <Link
        to={noProjects ? `/c/${company.slug}/tasks` : `/c/${company.slug}/employees`}
        className="mt-1 flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        {noProjects
          ? "Create a project to start tracking work"
          : "See what your AI employees are doing"}{" "}
        <ChevronRight size={12} />
      </Link>
    </section>
  );
}

// ───────────────────────── header ────────────────────────────────────────────

function Greeting({ me, company }: { me: Me; company: Company }) {
  const hour = new Date().getHours();
  const salute =
    hour < 5
      ? "Good night"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
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
  const dialog = useDialog();
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
      setVisible(false);
    } catch (err) {
      // The banner removes itself once permission is denied, so the failure
      // has nowhere on the page left to sit — say it in the modal instead.
      void dialog.error(err, { title: "Couldn’t enable push notifications" });
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
          Mentions, review requests, and approvals arrive as push notifications — even when Genosyn
          is closed.
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

/**
 * The four counters the strip can show. Split out so {@link hasAnythingToShow}
 * can ask whether any of them is non-zero without rebuilding the tiles.
 */
function statTotal(data: HomeData): number {
  return (
    data.unreadNotificationCount +
    data.myTodoCount +
    data.reviewTodoCount +
    data.pendingApprovalCount
  );
}

/**
 * Counters across the top. A tile at zero is dropped rather than rendered — the
 * strip exists to say how much is waiting, and "0" is the one number that says
 * nothing. All four at zero and the strip goes with them.
 *
 * The counts are the company's real backlog, not the length of the list in the
 * card below: a Member whose only pending approvals are vault captures sees the
 * tile (the count was never the sensitive part) while the card, which would
 * have to name them, stays hidden.
 */
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
      accent: "text-indigo-600 bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300",
    },
    {
      label: "Reviews waiting on you",
      value: data.reviewTodoCount,
      icon: <ClipboardCheck size={15} />,
      to: `/c/${company.slug}/tasks/review`,
      accent: "text-violet-600 bg-violet-100 dark:bg-violet-500/15 dark:text-violet-300",
    },
    {
      label: "Pending approvals",
      value: data.pendingApprovalCount,
      icon: <ShieldCheck size={15} />,
      to: `/c/${company.slug}/approvals`,
      accent: "text-amber-600 bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300",
    },
  ].filter((s) => s.value > 0);
  if (stats.length === 0) return null;
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

// ───────────────────────── decision stack ────────────────────────────────────

/**
 * The Decision Stack — the first thing on Home, above everything else.
 *
 * These are questions AI employees stopped to ask rather than guess at, so
 * every row here is an employee that is *blocked* until somebody answers. That
 * is why it outranks the failure alert below it: a failed routine already
 * happened, a pending decision is work not happening yet.
 *
 * Renders nothing when the stack is empty. A clean day should look clean.
 */
function DecisionStack({
  company,
  data,
  onResolved,
}: {
  company: Company;
  data: HomeData;
  onResolved: () => Promise<void> | void;
}) {
  if (data.decisions.length === 0) return null;
  const hidden = data.pendingDecisionCount - data.decisions.length;
  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-violet-200 bg-violet-50/50 shadow-sm dark:border-violet-500/30 dark:bg-violet-500/10">
      <div className="flex items-center gap-2 border-b border-violet-200/70 px-4 py-3 dark:border-violet-500/20">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300">
          <GitBranch size={15} />
        </span>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Decision stack</h2>
        <span className="rounded-full bg-violet-100 px-1.5 text-[10px] font-semibold tabular-nums text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
          {data.pendingDecisionCount}
        </span>
        <span className="hidden truncate text-xs text-slate-500 sm:inline dark:text-slate-400">
          Answer one and they carry on straight away
        </span>
        <Link
          to={`/c/${company.slug}/decisions`}
          className="ml-auto flex shrink-0 items-center gap-0.5 text-xs text-violet-700 hover:underline dark:text-violet-300"
        >
          All decisions <ChevronRight size={12} />
        </Link>
      </div>
      <ul className="divide-y divide-violet-100 bg-white/60 dark:divide-violet-500/15 dark:bg-slate-900/40">
        {data.decisions.map((d) => (
          <DecisionCard key={d.id} company={company} decision={d} onResolved={onResolved} />
        ))}
      </ul>
      {hidden > 0 && (
        <Link
          to={`/c/${company.slug}/decisions`}
          className="block border-t border-violet-100 px-4 py-2 text-center text-xs font-medium text-violet-700 hover:bg-violet-100/50 dark:border-violet-500/15 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {hidden} more waiting
        </Link>
      )}
    </section>
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
  // A run the server died in the middle of. Shares the panel with outright
  // failures — all three are work that didn't get done.
  if (r.status === "interrupted") return "interrupted";
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
  onChanged,
}: {
  company: Company;
  data: HomeData;
  /** Refetch Home data after a run is rerun or dismissed so the panel updates. */
  onChanged: () => Promise<void> | void;
}) {
  const dialog = useDialog();
  // Which row is mid-request, and which of its two buttons owns the spinner.
  const [busy, setBusy] = React.useState<{ runId: string; action: "rerun" | "dismiss" } | null>(
    null,
  );

  async function dismiss(runId: string) {
    setBusy({ runId, action: "dismiss" });
    try {
      await api.post(`/api/companies/${company.id}/runs/${runId}/dismiss`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t dismiss the failure" });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Start the routine again from here. Offered on interrupted runs only: the
   * server died mid-run, so nothing about the routine is known to be broken and
   * the work simply didn't happen. A `failed` or `timeout` run is a real
   * failure whose cause a human should read the log for first, and anything
   * with an automatic retry pending never reaches this panel.
   *
   * The run stopped somewhere unknown, so it may already have sent the email or
   * moved the money — the same caution the run history prints before its "Run
   * now" button, asked here as a confirm because this panel is one click from a
   * page nobody opened to think about side effects.
   *
   * Starting the rerun acknowledges the interrupted run, so the row drops off
   * instead of sitting there inviting a second, duplicate run.
   */
  async function rerun(r: HomeFailedRun) {
    const ok = await dialog.confirm({
      title: `Run ${r.routineName} again?`,
      message:
        "The server stopped part-way through, so nothing is known about work done after the log's last line. Run it again only if repeating that work is safe.",
      confirmLabel: "Rerun",
    });
    if (!ok) return;
    setBusy({ runId: r.runId, action: "rerun" });
    try {
      await api.post(`/api/companies/${company.id}/routines/${r.routineId}/run`);
      await api.post(`/api/companies/${company.id}/runs/${r.runId}/dismiss`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t run ${r.routineName} again` });
    } finally {
      setBusy(null);
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
                src={employeeAvatarUrl(company.id, r.employee.id, r.employee.avatarKey)}
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
            {/* An interrupted run is work that never happened, not a routine
                that misbehaved — offer the redo right where the failure is. */}
            {r.status === "interrupted" && (
              <button
                type="button"
                onClick={() => rerun(r)}
                disabled={busy?.runId === r.runId}
                title="Rerun"
                aria-label={`Rerun ${r.routineName}`}
                className="flex shrink-0 items-center gap-1 px-2 text-xs font-medium text-rose-700 transition hover:bg-rose-100/50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
              >
                {busy?.runId === r.runId && busy.action === "rerun" ? (
                  <Spinner size={14} />
                ) : (
                  <RotateCw size={14} />
                )}
                <span className="hidden sm:inline">Rerun</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(r.runId)}
              disabled={busy?.runId === r.runId}
              title="Dismiss"
              aria-label={`Dismiss ${r.routineName} failure`}
              className="flex shrink-0 items-center px-3 text-rose-400 transition hover:bg-rose-100/50 hover:text-rose-700 disabled:opacity-50 dark:text-rose-500/70 dark:hover:bg-rose-500/10 dark:hover:text-rose-200"
            >
              {busy?.runId === r.runId && busy.action === "dismiss" ? (
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

// ──────────────────────────────── TLDRs ──────────────────────────────────

/**
 * The newest unread company briefings. These sit below blocked Decisions and
 * failed Routines because they are context, not an interruption, but above
 * the small queue cards so the day's work can be understood at a glance.
 */
function HomeTldrPanel({
  company,
  data,
  onDismiss,
}: {
  company: Company;
  data: HomeData;
  onDismiss: (item: TldrItem) => void;
}) {
  if (data.tldrs.length === 0) return null;
  const visible = data.tldrs.slice(0, 3);
  const hidden = Math.max(0, data.unreadTldrCount - visible.length);
  const base = `/c/${company.slug}/tldrs`;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm dark:border-violet-500/25 dark:bg-slate-950">
      <div className="flex items-center gap-2 border-b border-violet-100 bg-violet-50/60 px-4 py-3 dark:border-violet-500/15 dark:bg-violet-500/10">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300">
          <Sparkles size={15} />
        </span>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Latest TLDRs</h2>
        <span className="rounded-full bg-violet-100 px-1.5 text-[10px] font-semibold tabular-nums text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
          {data.unreadTldrCount}
        </span>
        <span className="hidden truncate text-xs text-slate-500 sm:inline dark:text-slate-400">
          Public Workspace activity worth knowing about
        </span>
        <Link
          to={base}
          className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-medium text-violet-700 hover:underline dark:text-violet-300"
        >
          All TLDRs <ChevronRight size={12} />
        </Link>
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {visible.map((item) => (
          <article key={item.id} className="px-4 py-4 sm:px-5">
            <div className="flex items-start gap-3">
              <Avatar
                name={item.employee.name || "AI Employee"}
                src={
                  item.employee.id
                    ? employeeAvatarUrl(company.id, item.employee.id, item.employee.avatarKey)
                    : null
                }
                kind="ai"
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`${base}#tldr-${item.id}`}
                      className="font-medium text-slate-900 hover:text-violet-700 dark:text-slate-100 dark:hover:text-violet-300"
                    >
                      {item.title || "Company TLDR"}
                    </Link>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {item.employee.name || "AI Employee"} · {homeTldrPeriod(item)} ·{" "}
                      {formatRelative(item.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDismiss(item)}
                    className="-mr-1 inline-flex shrink-0 items-center gap-1 self-start rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label={`Dismiss ${item.title || "TLDR"}`}
                  >
                    <X size={13} /> Dismiss
                  </button>
                </div>

                <div className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
                  <ChatMarkdown content={item.summary || item.body} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
                  {item.sourceStats.routineRuns > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Play size={11} /> {item.sourceStats.routineRuns} Routine{" "}
                      {item.sourceStats.routineRuns === 1 ? "run" : "runs"}
                    </span>
                  )}
                  {item.sourceStats.channelMessages > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare size={11} /> {item.sourceStats.channelMessages}{" "}
                      {item.sourceStats.channelMessages === 1 ? "message" : "messages"} in{" "}
                      {item.sourceStats.channels}{" "}
                      {item.sourceStats.channels === 1 ? "channel" : "channels"}
                    </span>
                  )}
                  {item.sourceStats.journalEntries > 0 && (
                    <span>
                      {item.sourceStats.journalEntries} journal{" "}
                      {item.sourceStats.journalEntries === 1 ? "entry" : "entries"}
                    </span>
                  )}
                </div>
                <div className="mt-3">
                  {/* The conversation lives beside the briefing itself. The
                      hash lands on that card; `discuss` opens it there, so one
                      click still ends in a composer rather than a scroll. */}
                  <Link
                    to={`/c/${company.slug}/tldrs?discuss=${item.id}#tldr-${item.id}`}
                    className={buttonClassName({ variant: "secondary", size: "sm" })}
                  >
                    <MessageSquare size={14} />
                    Discuss
                    {item.questionCount > 0 && (
                      <span className="tabular-nums text-slate-400 dark:text-slate-500">
                        {item.questionCount}
                      </span>
                    )}
                  </Link>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>

      {hidden > 0 && (
        <Link
          to={base}
          className="block border-t border-violet-100 bg-violet-50/30 px-4 py-2 text-center text-xs font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-500/15 dark:bg-violet-500/5 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {hidden} more unread {hidden === 1 ? "briefing" : "briefings"}
        </Link>
      )}
    </section>
  );
}

function homeTldrPeriod(item: TldrItem): string {
  const start = new Date(item.periodStart);
  const end = new Date(item.periodEnd);
  const time = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (start.toDateString() === end.toDateString()) {
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(start)}–${time(end)}`;
  }
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// Shared card chrome for the smaller two-column attention queues below.
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
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
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

  if (data.notifications.length === 0) return null;
  return (
    <HomeCard
      title="Needs your attention"
      icon={<AtSign size={15} />}
      count={data.unreadNotificationCount}
      linkTo={`/c/${company.slug}`}
      linkLabel="Bell has history"
    >
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
    </HomeCard>
  );
}

function NotificationAvatar({ company, n }: { company: Company; n: NotificationRow }) {
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
      <Avatar name={actor.name} src={src} kind={actor.kind === "ai" ? "ai" : "human"} size="sm" />
    );
  }
  return (
    <span
      className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", tone.bg)}
    >
      <KindIcon kind={n.kind} className={tone.fg} />
    </span>
  );
}

function KindIcon({ kind, className }: { kind: NotificationKind; className?: string }) {
  switch (kind) {
    case "mention":
      return <AtSign size={12} className={className} />;
    case "todo_review_requested":
      return <ClipboardCheck size={12} className={className} />;
    case "approval_pending":
      return <ShieldCheck size={12} className={className} />;
    case "decision_pending":
      return <GitBranch size={12} className={className} />;
    case "finance_review_ready":
      return <Landmark size={12} className={className} />;
    case "mail_handover":
      return <Mail size={12} className={className} />;
    case "revenue_follow_up":
      return <BellRing size={12} className={className} />;
    case "run_failed":
      return <AlertTriangle size={12} className={className} />;
    case "run_off_goal":
      return <Target size={12} className={className} />;
    case "approval_stale":
      return <Hourglass size={12} className={className} />;
    case "decision_stale":
      return <Hourglass size={12} className={className} />;
    case "handoff_overdue":
      return <Hourglass size={12} className={className} />;
    case "goal_achieved":
      return <Target size={12} className={className} />;
    case "goal_missed":
      return <Target size={12} className={className} />;
    case "revision_pending":
      return <GitPullRequest size={12} className={className} />;
    case "revision_stale":
      return <GitPullRequest size={12} className={className} />;
    case "autonomy_revoked":
      return <ShieldAlert size={12} className={className} />;
    case "budget_exhausted":
      return <PiggyBank size={12} className={className} />;
    case "initiative_pending":
      return <Lightbulb size={12} className={className} />;
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
  decision_pending: {
    bg: "bg-violet-100 dark:bg-violet-500/15",
    fg: "text-violet-600 dark:text-violet-300",
  },
  finance_review_ready: {
    bg: "bg-emerald-100 dark:bg-emerald-500/15",
    fg: "text-emerald-600 dark:text-emerald-300",
  },
  mail_handover: {
    bg: "bg-sky-100 dark:bg-sky-500/15",
    fg: "text-sky-600 dark:text-sky-300",
  },
  revenue_follow_up: {
    bg: "bg-sky-100 dark:bg-sky-500/15",
    fg: "text-sky-600 dark:text-sky-300",
  },
  run_failed: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    fg: "text-rose-600 dark:text-rose-300",
  },
  run_off_goal: {
    bg: "bg-orange-100 dark:bg-orange-500/15",
    fg: "text-orange-600 dark:text-orange-300",
  },
  approval_stale: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    fg: "text-amber-600 dark:text-amber-300",
  },
  decision_stale: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    fg: "text-amber-600 dark:text-amber-300",
  },
  handoff_overdue: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    fg: "text-amber-600 dark:text-amber-300",
  },
  goal_achieved: {
    bg: "bg-emerald-100 dark:bg-emerald-500/15",
    fg: "text-emerald-600 dark:text-emerald-300",
  },
  goal_missed: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    fg: "text-rose-600 dark:text-rose-300",
  },
  revision_pending: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    fg: "text-amber-600 dark:text-amber-300",
  },
  revision_stale: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    fg: "text-rose-600 dark:text-rose-300",
  },
  autonomy_revoked: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    fg: "text-rose-600 dark:text-rose-300",
  },
  budget_exhausted: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    fg: "text-rose-600 dark:text-rose-300",
  },
  initiative_pending: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    fg: "text-amber-600 dark:text-amber-300",
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

function TodoList({ company, todos }: { company: Company; todos: HomeTodo[] }) {
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
                className={clsx("h-2 w-2 shrink-0 rounded-full", PRIORITY_DOT[t.priority])}
                title={`Priority: ${t.priority}`}
              />
              <span className="w-16 shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {t.project.key}-{t.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-900 dark:text-slate-100">
                {t.title}
              </span>
              {due && (
                <span className={clsx("flex shrink-0 items-center gap-1 text-[11px]", due.cls)}>
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
  if (data.myTodos.length === 0) return null;
  return (
    <HomeCard
      title="Your todos"
      icon={<ListChecks size={15} />}
      count={data.myTodoCount}
      linkTo={`/c/${company.slug}/tasks`}
      linkLabel="All tasks"
    >
      <TodoList company={company} todos={data.myTodos} />
    </HomeCard>
  );
}

function ReviewsCard({ company, data }: { company: Company; data: HomeData }) {
  if (data.reviewTodos.length === 0) return null;
  return (
    <HomeCard
      title="Reviews waiting on you"
      icon={<ClipboardCheck size={15} />}
      count={data.reviewTodoCount}
      linkTo={`/c/${company.slug}/tasks/review`}
      linkLabel="Review queue"
    >
      <TodoList company={company} todos={data.reviewTodos} />
    </HomeCard>
  );
}

// ───────────────────────── messages card ─────────────────────────────────────

function MessagesCard({ company, data }: { company: Company; data: HomeData }) {
  if (data.unreadChannels.length === 0) return null;
  return (
    <HomeCard
      title="Unread messages"
      icon={<MessageSquare size={15} />}
      count={data.unreadChannels.reduce((sum, c) => sum + c.unreadCount, 0)}
      linkTo={`/c/${company.slug}/workspace`}
      linkLabel="Workspace"
    >
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
    </HomeCard>
  );
}

// ───────────────────────── approvals card ────────────────────────────────────

/**
 * Pending approvals — gates the system put in front of an action an employee
 * already attempted. Not the decision stack above, which the employee raised
 * itself; see `AGENTS.md` on why the two never share a surface.
 *
 * Hidden when there is nothing to approve. The count in the header is the
 * company's full backlog, so it can exceed the rows shown when the server
 * withheld a vault-capture row from a non-admin Member.
 */
function ApprovalsCard({ company, data }: { company: Company; data: HomeData }) {
  if (data.approvals.length === 0) return null;
  return (
    <HomeCard
      title="Pending approvals"
      icon={<ShieldCheck size={15} />}
      count={data.pendingApprovalCount}
      linkTo={`/c/${company.slug}/approvals`}
      linkLabel="Approvals"
    >
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
                  {a.title || (a.routine ? `Run "${a.routine.name}"` : "Approval requested")}
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
      localStorage.setItem(HEALTH_DISMISS_PREFIX + companyId, JSON.stringify(map));
    }
  } catch {
    // localStorage may be unavailable (private mode) — dismissals just won't
    // persist across reloads, which is an acceptable degradation.
  }
}

function SystemHealthCard({ company, data }: { company: Company; data: HomeData }) {
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
  const visible = failing.filter((c) => !(c.id in dismissed) || c.count > dismissed[c.id]);
  const dismissedCount = failing.length - visible.length;

  // Nothing failing means nothing to say — the card disappears rather than
  // taking up a grid slot to report that all is well.
  if (failing.length === 0) return null;

  return (
    <HomeCard
      title="System health"
      icon={<Activity size={15} />}
      count={visible.length}
      linkTo={`/c/${company.slug}/settings/system-health`}
      linkLabel="Details"
    >
      {visible.length === 0 ? (
        <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-1.5 px-6 py-6 text-center">
          <CheckCircle2 size={18} className="text-slate-400 dark:text-slate-500" />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {dismissedCount} {dismissedCount === 1 ? "issue" : "issues"} dismissed on this device.
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
                  className={clsx("h-2 w-2 shrink-0 rounded-full", HEALTH_DOT[c.severity])}
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
  if (days === 1) return { label: "Tomorrow", cls: "text-amber-600 dark:text-amber-400" };
  return { label: month, cls: "text-slate-500 dark:text-slate-400" };
}
