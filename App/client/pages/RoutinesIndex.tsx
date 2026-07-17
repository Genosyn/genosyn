import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { AlertTriangle, CalendarClock, Pause, Play } from "lucide-react";
import { api, Company, RoutineWithMeta, Run } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { RunLiveModal, RunStatusChip, timeAgo, timeUntil } from "../components/routines/RunViews";
import { cronHuman } from "../lib/cron";
import { RoutinesContext } from "./RoutinesLayout";
import { TagChips, TagFilterBar } from "../components/TagPicker";

/**
 * Every routine in the company. Filterable by the employee it's assigned to
 * (`?employee=<slug>`, driven by the sidebar) and by health.
 *
 * Also the landing spot for the `?routine=<id>&run=<id>` deep links the Home
 * "Failed routines" panel and the Journal emit — those know a routine id but
 * not its slug, so this resolves the id against the loaded list and forwards
 * to the detail page.
 */

type Health = "all" | "active" | "paused" | "attention";

/**
 * Anything an operator would want to notice: a run that didn't finish
 * cleanly, or an enabled routine whose schedule will never fire. The latter
 * happens when a cron expression passes `node-cron`'s validation on save but
 * `cron-parser` can't compute a next occurrence from it, leaving `nextRunAt`
 * null — the routine looks fine and silently never runs.
 */
function needsAttention(r: RoutineWithMeta): boolean {
  if (r.lastRun?.status === "failed" || r.lastRun?.status === "timeout") return true;
  return r.enabled && r.nextRunAt === null;
}

export default function RoutinesIndex({ company }: { company: Company }) {
  const { routines, loading, refresh } = useOutletContext<RoutinesContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [health, setHealth] = React.useState<Health>("all");
  const [activeRun, setActiveRun] = React.useState<{
    routine: RoutineWithMeta;
    run: Run;
  } | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const handledDeepLinkRef = React.useRef(false);

  const employeeSlug = searchParams.get("employee");
  const selectedTagId = searchParams.get("tag");
  const employee = routines.find((r) => r.employee?.slug === employeeSlug)?.employee ?? null;

  // Deep link from Home / Journal: `?routine=<id>&run=<id>`. Resolve the id to
  // a slug pair and hand off to the detail page. Handled once, then stripped so
  // navigating back here doesn't bounce again.
  React.useEffect(() => {
    if (handledDeepLinkRef.current || loading) return;
    const routineId = searchParams.get("routine");
    if (!routineId) return;
    handledDeepLinkRef.current = true;
    const runId = searchParams.get("run");
    const target = routines.find((r) => r.id === routineId);
    if (!target || !target.employee) {
      toast("That routine no longer exists.", "error");
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("routine");
          next.delete("run");
          return next;
        },
        { replace: true },
      );
      return;
    }
    const qs = runId ? `?run=${encodeURIComponent(runId)}` : "";
    navigate(
      `/c/${company.slug}/routines/${target.employee.slug}/${target.slug}${qs}`,
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, routines]);

  async function triggerRun(r: RoutineWithMeta) {
    try {
      const run = await api.post<Run>(`/api/companies/${company.id}/routines/${r.id}/run`);
      setActiveRun({ routine: r, run });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const scoped = employeeSlug
    ? routines.filter((r) => r.employee?.slug === employeeSlug)
    : routines;
  const availableTags = React.useMemo(() => {
    const byId = new Map(
      routines.flatMap((routine) => routine.tags ?? []).map((tag) => [tag.id, tag]),
    );
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [routines]);

  const counts = {
    all: scoped.length,
    active: scoped.filter((r) => r.enabled).length,
    paused: scoped.filter((r) => !r.enabled).length,
    attention: scoped.filter(needsAttention).length,
  };

  const shown = scoped.filter((r) => {
    if (selectedTagId && !(r.tags ?? []).some((tag) => tag.id === selectedTagId)) return false;
    if (health === "active") return r.enabled;
    if (health === "paused") return !r.enabled;
    if (health === "attention") return needsAttention(r);
    return true;
  });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <Breadcrumbs
        items={[
          { label: "Routines", to: `/c/${company.slug}/routines` },
          ...(employee ? [{ label: employee.name }] : []),
        ]}
      />
      <TopBar
        title={employee ? `${employee.name}'s routines` : "Routines"}
        right={
          <Button onClick={() => navigate(`/c/${company.slug}/routines/new`)}>
            New routine
          </Button>
        }
      />

      {loading ? (
        <Spinner />
      ) : routines.length === 0 ? (
        <EmptyState
          title="No routines yet"
          description="A routine is recurring work an AI employee performs on a schedule — a morning digest, a weekly report, an hourly inbox sweep."
          action={
            <Button onClick={() => navigate(`/c/${company.slug}/routines/new`)}>
              New routine
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["paused", "Paused"],
                ["attention", "Needs attention"],
              ] as Array<[Health, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setHealth(key)}
                className={
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition " +
                  (health === key
                    ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")
                }
              >
                {key === "attention" && counts.attention > 0 && (
                  <AlertTriangle size={12} className="text-amber-500" />
                )}
                {label}
                <span className="tabular-nums text-slate-400 dark:text-slate-500">
                  {counts[key]}
                </span>
              </button>
            ))}
          </div>

          <TagFilterBar
            tags={availableTags}
            selectedId={selectedTagId}
            onSelect={(tagId) =>
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                if (tagId) next.set("tag", tagId);
                else next.delete("tag");
                return next;
              })
            }
          />

          {shown.length === 0 ? (
            <EmptyState
              title="Nothing here"
              description="No routines match this filter."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
              {/* Column headers are desktop-only; each row restates its own
                  labels once the grid collapses. */}
              <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 md:grid dark:border-slate-800 dark:text-slate-500">
                <div>Routine</div>
                <div>Assigned to</div>
                <div>Schedule</div>
                <div>Last run</div>
                <div className="w-16" />
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((r) => (
                  <RoutineRow
                    key={r.id}
                    company={company}
                    routine={r}
                    onRun={() => triggerRun(r)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {activeRun && (
        <RunLiveModal
          key={activeRun.run.id}
          company={company}
          routine={activeRun.routine}
          run={activeRun.run}
          onRetry={() => triggerRun(activeRun.routine)}
          onClose={() => {
            setActiveRun(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RoutineRow({
  company,
  routine: r,
  onRun,
}: {
  company: Company;
  routine: RoutineWithMeta;
  onRun: () => void;
}) {
  const to = r.employee
    ? `/c/${company.slug}/routines/${r.employee.slug}/${r.slug}`
    : null;
  const brokenSchedule = r.enabled && r.nextRunAt === null;

  return (
    <li className="grid grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-center md:gap-4 dark:hover:bg-slate-900">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {to ? (
            <Link
              to={to}
              className="truncate font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
            >
              {r.name}
            </Link>
          ) : (
            <span className="truncate font-medium text-slate-900 dark:text-slate-100">
              {r.name}
            </span>
          )}
          {!r.enabled && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <Pause size={9} /> paused
            </span>
          )}
          {r.requiresApproval && (
            <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
              approval
            </span>
          )}
        </div>
        {(r.tags ?? []).length > 0 && (
          <div className="mt-1">
            <TagChips tags={r.tags} limit={3} />
          </div>
        )}
        <div className="mt-0.5 truncate text-xs text-slate-400 md:hidden dark:text-slate-500">
          {cronHuman(r.cronExpr)}
        </div>
      </div>

      <div className="min-w-0">
        {r.employee ? (
          <Link
            to={`/c/${company.slug}/employees/${r.employee.slug}`}
            className="flex min-w-0 items-center gap-2 text-sm text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
          >
            <Avatar
              name={r.employee.name}
              src={employeeAvatarUrl(company.id, r.employee.id, r.employee.avatarKey)}
              kind="ai"
              size="xs"
            />
            <span className="truncate">{r.employee.name}</span>
          </Link>
        ) : (
          <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
        )}
      </div>

      <div className="hidden min-w-0 md:block">
        <div className="truncate text-sm text-slate-600 dark:text-slate-300" title={r.cronExpr}>
          {cronHuman(r.cronExpr)}
        </div>
        <div className="truncate text-xs text-slate-400 dark:text-slate-500">
          {brokenSchedule ? (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={10} /> never fires
            </span>
          ) : !r.enabled ? (
            "paused"
          ) : r.nextRunAt ? (
            <span title={new Date(r.nextRunAt).toLocaleString()}>
              next {timeUntil(r.nextRunAt)}
            </span>
          ) : (
            "—"
          )}
        </div>
      </div>

      <div className="min-w-0">
        {r.lastRun ? (
          <div className="flex items-center gap-2">
            <RunStatusChip status={r.lastRun.status} size="xs" />
            <span
              className="truncate text-xs text-slate-400 dark:text-slate-500"
              title={new Date(r.lastRun.startedAt).toLocaleString()}
            >
              {timeAgo(r.lastRun.startedAt)}
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">Never run</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 justify-self-start md:justify-self-end">
        <Button size="sm" variant="ghost" onClick={onRun} title="Run now">
          <Play size={14} /> Run
        </Button>
        {to && (
          <Link
            to={to}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Open routine"
            aria-label={`Open ${r.name}`}
          >
            <CalendarClock size={14} />
          </Link>
        )}
      </div>
    </li>
  );
}
