import React from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  BrainCircuit,
  Clock,
  Copy,
  Globe,
  Pause,
  Play,
  ShieldCheck,
  Timer,
  Trash2,
  Webhook,
} from "lucide-react";
import {
  AIModel,
  api,
  Company,
  Routine,
  RoutineWithMeta,
  Run,
  RunLog,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { copyToClipboard } from "../lib/clipboard";
import {
  RunLiveModal,
  RunLogPane,
  RunStatusChip,
  formatDuration,
  timeAgo,
  timeUntil,
} from "../components/routines/RunViews";
import { cronHuman, cronIsReadable } from "../lib/cron";
import { RoutinesContext } from "./RoutinesLayout";

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

export default function RoutineDetail({ company }: { company: Company }) {
  const { empSlug, routineSlug } = useParams();
  const { routines, loading, refresh } = useOutletContext<RoutinesContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeRun, setActiveRun] = React.useState<Run | null>(null);
  const { toast } = useToast();

  const routine =
    routines.find((r) => r.employee?.slug === empSlug && r.slug === routineSlug) ?? null;

  // A `?run=` deep link is a request to look at run history.
  const deepLinkedRun = searchParams.get("run");
  const tabParam = searchParams.get("tab") as Tab | null;
  const tab: Tab =
    tabParam && TABS.some(([t]) => t === tabParam)
      ? tabParam
      : deepLinkedRun
        ? "runs"
        : "overview";

  function setTab(next: Tab) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "overview") p.delete("tab");
        else p.set("tab", next);
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
      toast((err as Error).message, "error");
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

  return (
    <div className="mx-auto max-w-5xl p-6">
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
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
            <span title={routine.cronExpr}>{cronHuman(routine.cronExpr)}</span>
            {routine.enabled && routine.nextRunAt && (
              <>
                <span aria-hidden="true">·</span>
                <span title={new Date(routine.nextRunAt).toLocaleString()}>
                  next {timeUntil(routine.nextRunAt)}
                </span>
              </>
            )}
          </div>
        </div>
        <Button onClick={triggerRun}>
          <Play size={14} /> Run now
        </Button>
      </div>

      {brokenSchedule && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">This routine never fires.</div>
            <div className="text-xs">
              It&apos;s enabled, but no next run could be computed from{" "}
              <code className="font-mono">{routine.cronExpr}</code>. Edit the schedule
              under Settings, or run it manually.
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
        <OverviewTab company={company} routine={routine} onSeeRuns={() => setTab("runs")} />
      )}
      {tab === "brief" && <BriefTab company={company} routine={routine} />}
      {tab === "runs" && (
        <RunsTab
          company={company}
          routine={routine}
          initialRunId={deepLinkedRun}
          onRetry={triggerRun}
        />
      )}
      {tab === "settings" && (
        <SettingsTab company={company} routine={routine} onSaved={refresh} />
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
  );
}

// ───────────────────────────── Overview ─────────────────────────────────

function OverviewTab({
  company,
  routine,
  onSeeRuns,
}: {
  company: Company;
  routine: RoutineWithMeta;
  onSeeRuns: () => void;
}) {
  const [runs, setRuns] = React.useState<Run[] | null>(null);
  const [model, setModel] = React.useState<AIModel | null | undefined>(undefined);
  const emp = routine.employee;

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
    <div className="grid gap-4 md:grid-cols-2">
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
          <Row icon={<Globe size={14} />} label="Browser">
            {routine.browserEnabledOverride === true
              ? "Forced on for this routine"
              : routine.browserEnabledOverride === false
                ? "Forced off for this routine"
                : "Inherits the employee setting"}
          </Row>
          <Row icon={<Webhook size={14} />} label="Webhook">
            {routine.webhookEnabled ? "Enabled" : "Off"}
          </Row>
        </CardBody>
      </Card>

      <Card className="md:col-span-2">
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
                <li key={run.id} className="flex items-center gap-3 py-2 text-sm">
                  <RunStatusChip status={run.status} size="xs" />
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
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
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

// ─────────────────────────────── Brief ──────────────────────────────────

/**
 * The markdown brief the runner folds into the prompt every time the routine
 * fires. Round-trips against `Routine.body` via `/routines/:rid/readme`.
 */
function BriefTab({ company, routine }: { company: Company; routine: RoutineWithMeta }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/routines/${routine.id}/readme`)
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      })
      .catch((err) => toast((err as Error).message, "error"));
  }, [company.id, routine.id, toast]);

  async function save() {
    if (content === null) return;
    setSaving(true);
    try {
      await api.put(`/api/companies/${company.id}/routines/${routine.id}/readme`, { content });
      setSaved(content);
      toast("Brief saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  if (content === null) return <Spinner />;
  const dirty = content !== saved;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          What this employee should actually do each time the routine fires. Folded
          into the prompt on every run.
        </p>
        <MarkdownEditor value={content} onChange={setContent} rows={18} />
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
  initialRunId,
  onRetry,
}: {
  company: Company;
  routine: RoutineWithMeta;
  initialRunId: string | null;
  onRetry: () => void;
}) {
  const [runs, setRuns] = React.useState<Run[] | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<RunLog | null>(null);
  const [loadingLog, setLoadingLog] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    (async () => {
      try {
        const list = await api.get<Run[]>(
          `/api/companies/${company.id}/routines/${routine.id}/runs`,
        );
        setRuns(list);
        if (list.length > 0) {
          // Prefer the deep-linked run when it's still in the recent window.
          setActiveId(
            initialRunId && list.some((r) => r.id === initialRunId) ? initialRunId : list[0].id,
          );
        }
      } catch (err) {
        toast((err as Error).message, "error");
        setRuns([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, routine.id]);

  React.useEffect(() => {
    if (!activeId) {
      setLog(null);
      return;
    }
    setLoadingLog(true);
    let cancelled = false;
    (async () => {
      try {
        const l = await api.get<RunLog>(`/api/companies/${company.id}/runs/${activeId}/log`);
        if (!cancelled) setLog(l);
      } catch (err) {
        if (!cancelled) toast((err as Error).message, "error");
      } finally {
        if (!cancelled) setLoadingLog(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, activeId]);

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 md:flex-row" style={{ minHeight: 460 }}>
        <aside className="max-h-48 w-full shrink-0 overflow-y-auto rounded-lg border border-slate-200 bg-white md:max-h-none md:w-64 dark:border-slate-700 dark:bg-slate-950">
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
                    {r.exitCode !== null && (
                      <span className="text-[10px] text-slate-400 dark:text-slate-500">
                        exit {r.exitCode}
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
        <RunLogPane
          log={log}
          loading={loadingLog}
          placeholder="(empty log)"
          className="h-full max-h-[60vh] min-h-[400px]"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {activeRun && (activeRun.status === "failed" || activeRun.status === "timeout")
            ? "This run didn't finish cleanly. Retry to run the routine again now."
            : "Showing the 50 most recent runs."}
        </div>
        <Button variant="secondary" onClick={onRetry}>
          <Play size={14} /> Run now
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────── Settings ────────────────────────────────

function SettingsTab({
  company,
  routine,
  onSaved,
}: {
  company: Company;
  routine: RoutineWithMeta;
  onSaved: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const emp = routine.employee;

  const [name, setName] = React.useState(routine.name);
  const [cronExpr, setCronExpr] = React.useState(routine.cronExpr);
  const [enabled, setEnabled] = React.useState(routine.enabled);
  const [timeoutSec, setTimeoutSec] = React.useState(routine.timeoutSec ?? 3600);
  const [requiresApproval, setRequiresApproval] = React.useState(
    routine.requiresApproval ?? false,
  );
  // "" is the inherit choice — the routine follows the employee's active model.
  const [modelId, setModelId] = React.useState(routine.modelId ?? "");
  const [models, setModels] = React.useState<AIModel[] | null>(null);
  // Tri-state: "inherit" reads as null, "on"/"off" force a boolean override.
  const [browserOverride, setBrowserOverride] = React.useState<"inherit" | "on" | "off">(
    routine.browserEnabledOverride === true
      ? "on"
      : routine.browserEnabledOverride === false
        ? "off"
        : "inherit",
  );
  const [webhookEnabled, setWebhookEnabled] = React.useState(routine.webhookEnabled);
  const [webhookToken, setWebhookToken] = React.useState(routine.webhookToken);
  const [saving, setSaving] = React.useState(false);

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

  async function toggleWebhook(next: boolean) {
    try {
      const updated = await api.post<Routine>(
        `/api/companies/${company.id}/routines/${routine.id}/webhook`,
        { enabled: next },
      );
      setWebhookEnabled(updated.webhookEnabled);
      setWebhookToken(updated.webhookToken);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/companies/${company.id}/routines/${routine.id}`, {
        name,
        cronExpr,
        enabled,
        timeoutSec,
        requiresApproval,
        modelId: modelId || null,
        browserEnabledOverride:
          browserOverride === "on" ? true : browserOverride === "off" ? false : null,
      });
      await onSaved();
      toast("Routine saved", "success");
      // The slug is stable across renames, so the address survives — but the
      // list behind it has to reload before the header shows the new name.
    } catch (err) {
      toast((err as Error).message, "error");
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
                : "Inherit follows whichever model is active for the employee. Pinning applies to this routine's runs only — chat always uses the active model."}
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
              Inherit uses the employee&apos;s Browser access setting. An override applies
              only to this routine&apos;s runs.
            </div>
          </div>
        </CardBody>
      </Card>

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
                  toast("Webhook token regenerated", "success");
                }}
              >
                Regenerate token
              </Button>
            )}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            External systems POST here to fire this routine. The URL itself is the
            credential — keep it secret. This one saves immediately.
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
                  const ok = await copyToClipboard(webhookUrl);
                  toast(ok ? "Copied" : "Could not access clipboard", ok ? "success" : "error");
                }}
              >
                <Copy size={12} />
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

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
              The schedule and its brief go away. Past run logs are deleted with it.
            </div>
          </div>
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await dialog.confirm({
                title: `Delete routine "${routine.name}"?`,
                message:
                  "The schedule and its brief will be removed, along with this routine's run history.",
                confirmLabel: "Delete routine",
                variant: "danger",
              });
              if (!ok) return;
              try {
                await api.del(`/api/companies/${company.id}/routines/${routine.id}`);
                await onSaved();
                navigate(`/c/${company.slug}/routines`, { replace: true });
              } catch (err) {
                toast((err as Error).message, "error");
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
