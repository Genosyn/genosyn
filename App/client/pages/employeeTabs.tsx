import React from "react";
import {
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
  useSearchParams,
} from "react-router-dom";
import {
  BrainCircuit,
  Brain,
  Camera,
  Check,
  Copy,
  Edit3,
  ExternalLink,
  Globe,
  Loader2,
  BookText,
  History,
  Play,
  Plug,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Unplug,
  UserRound,
  X,
} from "lucide-react";
import cronstrue from "cronstrue";
import {
  api,
  AIModel,
  AuthMode,
  Company,
  Employee,
  Provider,
  Routine,
  Run,
  RunLog,
  RunStatus,
  Skill,
  JournalEntry as JournalEntryT,
  JournalKind,
  MemoryItem,
  McpServer,
  McpTransport,
  Team,
} from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { Select } from "../components/ui/Select";
import { FormError } from "../components/ui/FormError";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * The individual employee sub-pages. Previously these were tabs on
 * EmployeeDetail.tsx — now each is a route rendered inside EmployeeLayout
 * via <Outlet context>. The logic inside each component is mostly a
 * straight lift of the old tab bodies.
 */

function useCtx(): EmployeeOutletCtx {
  return useOutletContext<EmployeeOutletCtx>();
}

/**
 * SoulCard — the Soul editor. Used inline on the employee Settings page
 * (no longer has its own sidebar entry; Soul sits with the rest of the
 * per-employee settings). Round-trips the Soul body against
 * `AIEmployee.soulBody` via `/api/.../employees/:eid/soul`.
 */
function SoulCard({ company, emp }: { company: Company; emp: Employee }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/employees/${emp.id}/soul`)
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      });
  }, [company.id, emp.id]);

  const dirty = content !== null && saved !== null && content !== saved;

  const save = React.useCallback(async () => {
    if (content === null || saving) return;
    setSaving(true);
    try {
      await api.put(`/api/companies/${company.id}/employees/${emp.id}/soul`, { content });
      setSaved(content);
      toast("Soul saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [company.id, emp.id, content, saving, toast]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Soul</span>
              {dirty && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  Unsaved
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {emp.name}&apos;s constitution — the markdown {emp.name} reads
              before every task.
            </div>
          </div>
        </div>
        {content === null ? (
          <Spinner />
        ) : (
          <>
            <MarkdownEditor value={content} onChange={setContent} rows={16} onSave={save} />
            <div className="flex items-center gap-2">
              <Button onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save Soul"}
              </Button>
              <span className="text-xs text-slate-400 dark:text-slate-500">⌘S to save</span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function SkillsPage() {
  const { company, emp } = useCtx();
  const [skills, setSkills] = React.useState<Skill[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [editing, setEditing] = React.useState<Skill | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  async function reload() {
    const s = await api.get<Skill[]>(
      `/api/companies/${company.id}/employees/${emp.id}/skills`,
    );
    setSkills(s);
  }
  React.useEffect(() => {
    reload().catch(() => setSkills([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  return (
    <>
      <TopBar
        title="Skills"
        right={<Button onClick={() => setAdding(true)}>New skill</Button>}
      />
      {skills === null ? (
        <Spinner />
      ) : skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          description="Skills are markdown playbooks an employee can apply to their work."
        />
      ) : (
        <div className="grid gap-3">
          {skills.map((s) => (
            <Card key={s.id} className="cursor-pointer" onClick={() => setEditing(s)}>
              <CardBody className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-400 dark:text-slate-500">@{s.slug}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const ok = await dialog.confirm({
                      title: `Delete skill "${s.name}"?`,
                      message: "The skill's README and metadata will be removed from this employee.",
                      confirmLabel: "Delete skill",
                      variant: "danger",
                    });
                    if (!ok) return;
                    await api.del(`/api/companies/${company.id}/skills/${s.id}`);
                    reload();
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="New skill">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post(
                `/api/companies/${company.id}/employees/${emp.id}/skills`,
                { name },
              );
              setName("");
              setAdding(false);
              await reload();
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }}
        >
          <Input
            label="Skill name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Button type="submit">Create</Button>
        </form>
      </Modal>
      {editing && (
        <SkillEditor company={company} skill={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function SkillEditor({
  company,
  skill,
  onClose,
}: {
  company: Company;
  skill: Skill;
  onClose: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/skills/${skill.id}/readme`)
      .then((r) => setContent(r.content));
  }, [company.id, skill.id]);

  return (
    <Modal open onClose={onClose} title={`Skill: ${skill.name}`}>
      {content === null ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3">
          <MarkdownEditor value={content} onChange={setContent} rows={14} />
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                setSaving(true);
                try {
                  await api.put(`/api/companies/${company.id}/skills/${skill.id}/readme`, {
                    content,
                  });
                  toast("Skill saved", "success");
                  onClose();
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function RoutinesPage() {
  const { company, emp } = useCtx();
  const [routines, setRoutines] = React.useState<Routine[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Routine | null>(null);
  const [viewingRuns, setViewingRuns] = React.useState<Routine | null>(null);
  const [focusRunId, setFocusRunId] = React.useState<string | null>(null);
  const [activeRun, setActiveRun] = React.useState<{ routine: Routine; run: Run } | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const handledDeepLinkRef = React.useRef(false);

  async function reload() {
    const r = await api.get<Routine[]>(
      `/api/companies/${company.id}/employees/${emp.id}/routines`,
    );
    setRoutines(r);
  }

  // Kick off a fresh run and open the live-log modal. Shared by the card's
  // Run button and the Retry buttons in the run-history / in-progress modals.
  async function triggerRun(r: Routine) {
    try {
      const run = await api.post<Run>(
        `/api/companies/${company.id}/routines/${r.id}/run`,
      );
      setActiveRun({ routine: r, run });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  function openRuns(r: Routine, runId: string | null = null) {
    setFocusRunId(runId);
    setViewingRuns(r);
  }

  React.useEffect(() => {
    reload().catch(() => setRoutines([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  // Deep-link from the Journal / Home: `?routine=<id>&run=<id>` opens that
  // routine's run history on the referenced run. Handle once, then strip the
  // params so navigating around (or refreshing) doesn't re-open the modal.
  React.useEffect(() => {
    if (handledDeepLinkRef.current || routines === null) return;
    const routineId = searchParams.get("routine");
    if (!routineId) return;
    handledDeepLinkRef.current = true;
    const runId = searchParams.get("run");
    const target = routines.find((r) => r.id === routineId);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("routine");
        next.delete("run");
        return next;
      },
      { replace: true },
    );
    if (target) openRuns(target, runId);
    else toast("That routine no longer exists.", "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routines]);

  return (
    <>
      <TopBar
        title="Routines"
        right={<Button onClick={() => setAdding(true)}>New routine</Button>}
      />
      {routines === null ? (
        <Spinner />
      ) : routines.length === 0 ? (
        <EmptyState
          title="No routines yet"
          description="Routines are cron-scheduled work this employee performs automatically."
        />
      ) : (
        <div className="grid gap-3">
          {routines.map((r) => (
            <Card key={r.id}>
              <CardBody className="flex items-center justify-between gap-4">
                <div
                  className="min-w-0 flex-1 cursor-pointer"
                  onClick={() => setEditing(r)}
                >
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{r.name}</div>
                    {!r.enabled && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        paused
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{cronHuman(r.cronExpr)}</div>
                  <div className="text-xs text-slate-400 dark:text-slate-500">
                    {r.lastRunAt ? `Last run ${new Date(r.lastRunAt).toLocaleString()}` : "Never run"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => triggerRun(r)}
                  >
                    <Play size={14} /> Run
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openRuns(r)}>
                    <History size={14} /> Runs
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await dialog.confirm({
                        title: `Delete routine "${r.name}"?`,
                        message: "The cron schedule and its README will be removed. Past run logs are preserved.",
                        confirmLabel: "Delete routine",
                        variant: "danger",
                      });
                      if (!ok) return;
                      await api.del(`/api/companies/${company.id}/routines/${r.id}`);
                      reload();
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <NewRoutineModal
          company={company}
          emp={emp}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {editing && (
        <RoutineEditor
          company={company}
          routine={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {viewingRuns && (
        <RunsModal
          company={company}
          routine={viewingRuns}
          initialRunId={focusRunId}
          onClose={() => setViewingRuns(null)}
          onRetry={() => {
            const r = viewingRuns;
            setViewingRuns(null);
            triggerRun(r);
          }}
        />
      )}
      {activeRun && (
        <RunInProgressModal
          key={activeRun.run.id}
          company={company}
          routine={activeRun.routine}
          run={activeRun.run}
          onRetry={() => triggerRun(activeRun.routine)}
          onClose={() => {
            setActiveRun(null);
            reload();
          }}
        />
      )}
    </>
  );
}

const RUN_STATUS_STYLE: Record<RunStatus, string> = {
  running: "bg-sky-50 text-sky-700 border-sky-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
  skipped: "bg-amber-50 text-amber-700 border-amber-200",
  timeout: "bg-orange-50 text-orange-700 border-orange-200",
};

function formatDuration(started: string, finished: string | null): string {
  if (!finished) return "—";
  const ms = new Date(finished).getTime() - new Date(started).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

/**
 * Live tail for a run that's just been kicked off. Polls /runs/:runId/log on
 * a short interval until the server reports a terminal status; the same
 * endpoint serves the in-memory buffer while the child is alive and the
 * persisted `logContent` once it has finalized, so this doesn't need a
 * separate "is the run done" probe.
 */
function RunInProgressModal({
  company,
  routine,
  run: initialRun,
  onClose,
  onRetry,
}: {
  company: Company;
  routine: Routine;
  run: Run;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const [log, setLog] = React.useState<RunLog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const preRef = React.useRef<HTMLPreElement>(null);
  const userScrolledRef = React.useRef(false);

  const status: RunStatus = log?.status ?? initialRun.status;
  const isTerminal = status !== "running";

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const next = await api.get<RunLog>(
          `/api/companies/${company.id}/runs/${initialRun.id}/log`,
        );
        if (cancelled) return;
        setLog(next);
        setError(null);
        if (next.status === "running") {
          timer = setTimeout(tick, 1200);
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        // Keep polling on transient errors so a flaky network doesn't end the
        // tail prematurely; back off a bit.
        timer = setTimeout(tick, 2500);
      }
    }
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [company.id, initialRun.id]);

  // Auto-scroll the pre to the bottom as new content arrives, unless the user
  // has scrolled away from the bottom themselves (so reading mid-log isn't
  // yanked out from under them).
  React.useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [log?.content]);

  function handleScroll() {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    userScrolledRef.current = !atBottom;
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Run: ${routine.name}`}
      size="xl"
    >
      <div className="flex flex-col gap-3" style={{ minHeight: 420 }}>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              "rounded border px-2 py-0.5 font-medium uppercase tracking-wide " +
              RUN_STATUS_STYLE[status]
            }
          >
            {status === "running" ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" /> running
              </span>
            ) : (
              status
            )}
          </span>
          {log?.exitCode !== null && log?.exitCode !== undefined && (
            <span className="text-slate-500 dark:text-slate-400">
              exit {log.exitCode}
            </span>
          )}
          {log?.startedAt && (
            <span className="text-slate-400 dark:text-slate-500">
              {formatDuration(
                log.startedAt,
                log.finishedAt ?? (isTerminal ? new Date().toISOString() : null),
              )}
            </span>
          )}
          {log?.live && (
            <span className="text-slate-400 dark:text-slate-500">live</span>
          )}
          {error && (
            <span className="text-rose-500 dark:text-rose-400">{error}</span>
          )}
        </div>
        <div className="flex-1 overflow-hidden rounded-lg border border-slate-200 bg-slate-950 dark:border-slate-700">
          <pre
            ref={preRef}
            onScroll={handleScroll}
            className="h-full max-h-[60vh] min-h-[360px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-100"
          >
            {log === null ? (
              <span className="text-slate-500">Starting…</span>
            ) : log.content ? (
              <>
                {log.truncated && (
                  <div className="mb-2 text-amber-400">
                    [log truncated — first 256KB of {log.size} bytes]
                  </div>
                )}
                {log.content}
              </>
            ) : (
              <span className="text-slate-500">Waiting for output…</span>
            )}
          </pre>
        </div>
        <div className="flex justify-end gap-2">
          {onRetry && isTerminal && (status === "failed" || status === "timeout") && (
            <Button variant="secondary" onClick={onRetry}>
              <RotateCcw size={14} /> Retry
            </Button>
          )}
          <Button variant={isTerminal ? "primary" : "secondary"} onClick={onClose}>
            {isTerminal ? "Close" : "Close (run continues)"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Per-routine run history. Left rail lists recent runs newest-first; picking
 * one loads its captured log on the right. Logs are truncated at 256KB
 * server-side and the tail is shown — runaway output shouldn't DoS the UI.
 */
function RunsModal({
  company,
  routine,
  initialRunId,
  onClose,
  onRetry,
}: {
  company: Company;
  routine: Routine;
  initialRunId?: string | null;
  onClose: () => void;
  onRetry?: () => void;
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
          // Prefer the deep-linked run when it's in the recent window, else
          // fall back to the newest run.
          const focused =
            initialRunId && list.some((r) => r.id === initialRunId)
              ? initialRunId
              : list[0].id;
          setActiveId(focused);
        }
      } catch (err) {
        toast((err as Error).message, "error");
        setRuns([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine.id]);

  React.useEffect(() => {
    if (!activeId) {
      setLog(null);
      return;
    }
    setLoadingLog(true);
    (async () => {
      try {
        const l = await api.get<RunLog>(
          `/api/companies/${company.id}/runs/${activeId}/log`,
        );
        setLog(l);
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        setLoadingLog(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const activeRun = runs?.find((r) => r.id === activeId) ?? null;

  return (
    <Modal open onClose={onClose} title={`Runs: ${routine.name}`} size="xl">
      {runs === null ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Click Run on the routine card to trigger it, or wait for its cron to fire."
        />
      ) : (
        <div className="flex gap-3" style={{ minHeight: 420 }}>
          <aside className="w-64 shrink-0 overflow-y-auto rounded-lg border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700">
            <ul className="flex flex-col">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setActiveId(r.id)}
                    className={
                      "flex w-full flex-col gap-0.5 border-b border-slate-100 px-3 py-2 text-left text-xs dark:border-slate-800" +
                      (r.id === activeId ? "bg-slate-50 dark:bg-slate-900" : "hover:bg-slate-50 dark:hover:bg-slate-800")
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                          RUN_STATUS_STYLE[r.status]
                        }
                      >
                        {r.status}
                      </span>
                      {r.exitCode !== null && (
                        <span className="text-[10px] text-slate-400 dark:text-slate-500">exit {r.exitCode}</span>
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
          <div className="flex-1 overflow-hidden rounded-lg border border-slate-200 bg-slate-950 dark:border-slate-700">
            {loadingLog ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-500 dark:text-slate-400">
                <Loader2 size={14} className="mr-2 animate-spin" /> Loading log…
              </div>
            ) : log === null ? null : (
              <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                {log.truncated && (
                  <div className="mb-2 text-amber-400">
                    [log truncated — first 256KB of {log.size} bytes]
                  </div>
                )}
                {log.content || "(empty log)"}
              </pre>
            )}
          </div>
        </div>
      )}
      {onRetry && runs && runs.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {activeRun && (activeRun.status === "failed" || activeRun.status === "timeout")
              ? "This run didn't finish cleanly. Retry to run the routine again now."
              : "Run the routine again now, outside its schedule."}
          </div>
          <Button variant="secondary" onClick={onRetry}>
            <RotateCcw size={14} /> Retry
          </Button>
        </div>
      )}
    </Modal>
  );
}

function cronHuman(expr: string): string {
  try {
    return cronstrue.toString(expr);
  } catch {
    return expr;
  }
}

const PRESETS: Array<{ label: string; expr: string }> = [
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Every weekday 9am", expr: "0 9 * * 1-5" },
  { label: "Every Monday 9am", expr: "0 9 * * 1" },
  { label: "Every day 8am", expr: "0 8 * * *" },
];

function NewRoutineModal({
  company,
  emp,
  onClose,
  onCreated,
}: {
  company: Company;
  emp: Employee;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [cronExpr, setCronExpr] = React.useState("0 9 * * 1-5");
  const { toast } = useToast();

  return (
    <Modal open onClose={onClose} title="New routine">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post(`/api/companies/${company.id}/employees/${emp.id}/routines`, {
              name,
              cronExpr,
            });
            onCreated();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      >
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input
          label="Cron expression"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          required
        />
        <div className="-mt-2 text-xs text-slate-500 dark:text-slate-400">{cronHuman(cronExpr)}</div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.expr}
              type="button"
              onClick={() => setCronExpr(p.expr)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {p.label}
            </button>
          ))}
        </div>
        <Button type="submit">Create</Button>
      </form>
    </Modal>
  );
}

function RoutineEditor({
  company,
  routine,
  onClose,
  onSaved,
}: {
  company: Company;
  routine: Routine;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [name, setName] = React.useState(routine.name);
  const [cronExpr, setCronExpr] = React.useState(routine.cronExpr);
  const [enabled, setEnabled] = React.useState(routine.enabled);
  const [timeoutSec, setTimeoutSec] = React.useState(routine.timeoutSec ?? 3600);
  const [requiresApproval, setRequiresApproval] = React.useState(
    routine.requiresApproval ?? false,
  );
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
  const { toast } = useToast();

  async function toggleWebhook(enabled: boolean) {
    try {
      const updated = await api.post<Routine>(
        `/api/companies/${company.id}/routines/${routine.id}/webhook`,
        { enabled },
      );
      setWebhookEnabled(updated.webhookEnabled);
      setWebhookToken(updated.webhookToken);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/routines/${routine.id}/readme`)
      .then((r) => setContent(r.content));
  }, [company.id, routine.id]);

  return (
    <Modal open onClose={onClose} title={`Routine: ${routine.name}`}>
      {content === null ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label="Cron expression"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
          />
          <div className="-mt-2 text-xs text-slate-500 dark:text-slate-400">{cronHuman(cronExpr)}</div>
          <Input
            label="Timeout (seconds)"
            type="number"
            min={10}
            max={21600}
            value={String(timeoutSec)}
            onChange={(e) => setTimeoutSec(Math.max(10, Number(e.target.value) || 3600))}
          />
          <div className="-mt-2 text-xs text-slate-500 dark:text-slate-400">
            Hard kill after this long. The Run is marked <code>timeout</code>.
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requiresApproval}
              onChange={(e) => setRequiresApproval(e.target.checked)}
            />
            Require approval before each scheduled run
          </label>
          <div className="-mt-2 text-xs text-slate-500 dark:text-slate-400">
            Manual &quot;Run now&quot; still runs immediately — a human is already in the loop.
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
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
              Inherit uses the employee&apos;s Browser access setting. Override applies only to
              this routine&apos;s scheduled runs.
            </div>
          </div>
          <WebhookField
            enabled={webhookEnabled}
            token={webhookToken}
            routineId={routine.id}
            onToggle={toggleWebhook}
          />
          <MarkdownEditor value={content} onChange={setContent} rows={12} />
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  await api.patch(`/api/companies/${company.id}/routines/${routine.id}`, {
                    name,
                    cronExpr,
                    enabled,
                    timeoutSec,
                    requiresApproval,
                    browserEnabledOverride:
                      browserOverride === "on"
                        ? true
                        : browserOverride === "off"
                          ? false
                          : null,
                  });
                  await api.put(
                    `/api/companies/${company.id}/routines/${routine.id}/readme`,
                    { content },
                  );
                  toast("Routine saved", "success");
                  onSaved();
                } catch (err) {
                  toast((err as Error).message, "error");
                }
              }}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- Model (Settings) tab ----------

const PROVIDER_DEFAULTS: Record<
  Provider,
  { label: string; model: string; authMode: AuthMode }
> = {
  anthropic: { label: "Anthropic (Claude)", model: "claude-opus-4-6", authMode: "apikey" },
  openai: { label: "OpenAI (GPT)", model: "gpt-4o", authMode: "apikey" },
  custom: { label: "Custom OpenAI-compatible endpoint", model: "", authMode: "customEndpoint" },
};

/**
 * Employee Settings. Soul + Model used to share one scroll-heavy page; now
 * each is its own sub-route with a small side nav. New per-employee setting
 * surfaces (permissions, memory retention, notifications) slot in as extra
 * sidebar entries rather than another stacked card.
 */
export function SettingsPage() {
  return (
    <>
      <TopBar title="Settings" />
      <div className="flex gap-6">
        <SettingsSideNav />
        <div className="min-w-0 flex-1">
          <Outlet context={useCtx()} />
        </div>
      </div>
    </>
  );
}

function SettingsSideNav() {
  return (
    <nav className="w-44 shrink-0">
      <ul className="flex flex-col gap-0.5">
        <SettingsNavItem to="general" icon={<UserRound size={14} />} label="General" />
        <SettingsNavItem to="soul" icon={<Sparkles size={14} />} label="Soul" />
        <SettingsNavItem to="model" icon={<BrainCircuit size={14} />} label="Model" />
        <SettingsNavItem to="browser" icon={<Globe size={14} />} label="Browser" />
      </ul>
    </nav>
  );
}

function SettingsNavItem({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <NavLink
        to={to}
        className={({ isActive }) =>
          "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm " +
          (isActive
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
        }
      >
        {icon}
        {label}
      </NavLink>
    </li>
  );
}

export function SoulSettingsPage() {
  const { company, emp } = useCtx();
  return <SoulCard company={company} emp={emp} />;
}

/**
 * General settings for an employee — name, role, slug, and profile picture.
 * Slug edits rename the on-disk employee directory (so credential paths
 * stay stable) and bounce the URL once the PATCH lands. The avatar uploader
 * round-trips through the multipart POST on `/employees/:eid/avatar`.
 */
export function GeneralSettingsPage() {
  const { company, emp } = useCtx();
  return (
    <div className="flex flex-col gap-4">
      <EmployeeAvatarCard company={company} emp={emp} />
      <EmployeeBasicsCard company={company} emp={emp} />
      <EmployeeOrgCard company={company} emp={emp} />
    </div>
  );
}

export function BrowserSettingsPage() {
  const { company, emp } = useCtx();
  return <EmployeeBrowserAccessCard company={company} emp={emp} />;
}

function EmployeeOrgCard({
  company,
  emp,
}: {
  company: Company;
  emp: Employee;
}) {
  const [teams, setTeams] = React.useState<Team[] | null>(null);
  const [peers, setPeers] = React.useState<Employee[] | null>(null);
  const [teamId, setTeamId] = React.useState<string>(emp.teamId ?? "");
  const [reportsTo, setReportsTo] = React.useState<string>(
    emp.reportsToEmployeeId ?? "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setTeamId(emp.teamId ?? "");
    setReportsTo(emp.reportsToEmployeeId ?? "");
  }, [emp.id, emp.teamId, emp.reportsToEmployeeId]);

  React.useEffect(() => {
    api
      .get<Team[]>(`/api/companies/${company.id}/teams`)
      .then((list) => setTeams(list.filter((t) => !t.archivedAt)))
      .catch(() => setTeams([]));
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => setPeers(list.filter((e) => e.id !== emp.id)))
      .catch(() => setPeers([]));
  }, [company.id, emp.id]);

  const dirty =
    (teamId || null) !== (emp.teamId ?? null) ||
    (reportsTo || null) !== (emp.reportsToEmployeeId ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    setError(null);
    setSaving(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        {
          teamId: teamId || null,
          reportsToEmployeeId: reportsTo || null,
        },
      );
      toast("Org chart updated", "success");
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Org chart
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            The team this employee belongs to and who they report to. Manager
            is used by the <code className="font-mono">create_handoff</code>{" "}
            <code className="font-mono">toManager: true</code> shortcut.
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <FormError message={error} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              Team
            </span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={!teams}
            >
              <option value="">— No team —</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              Reports to
            </span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={reportsTo}
              onChange={(e) => setReportsTo(e.target.value)}
              disabled={!peers}
            >
              <option value="">— No manager —</option>
              {(peers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function EmployeeAvatarCard({ company, emp }: { company: Company; emp: Employee }) {
  const [avatarKey, setAvatarKey] = React.useState<string | null>(
    emp.avatarKey ?? null,
  );
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setAvatarKey(emp.avatarKey ?? null);
  }, [emp.id, emp.avatarKey]);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/companies/${company.id}/employees/${emp.id}/avatar`,
        { method: "POST", credentials: "same-origin", body: fd },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = res.statusText;
        try {
          msg = JSON.parse(text).error ?? msg;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { avatarKey: string };
      setAvatarKey(data.avatarKey);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    try {
      await api.del(`/api/companies/${company.id}/employees/${emp.id}/avatar`);
      setAvatarKey(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Profile picture
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Shown in the sidebar, employee list, and workspace chat. PNG, JPEG,
            GIF, or WebP up to 5&nbsp;MB.
          </div>
        </div>
        <FormError message={error} />
        <div className="flex items-center gap-4">
          <Avatar
            name={emp.name}
            kind="ai"
            size="xl"
            src={employeeAvatarUrl(company.id, emp.id, avatarKey)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              <Camera size={12} /> {uploading ? "Uploading…" : "Upload new"}
            </Button>
            {avatarKey && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={uploading}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function EmployeeBasicsCard({ company, emp }: { company: Company; emp: Employee }) {
  const navigate = useNavigate();
  const [name, setName] = React.useState(emp.name);
  const [role, setRole] = React.useState(emp.role);
  const [slug, setSlug] = React.useState(emp.slug);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setName(emp.name);
    setRole(emp.role);
    setSlug(emp.slug);
  }, [emp.id, emp.name, emp.role, emp.slug]);

  const normalizedSlug = normalizeSlug(slug);
  const dirty =
    name.trim() !== emp.name ||
    role.trim() !== emp.role ||
    (normalizedSlug.length > 0 && normalizedSlug !== emp.slug);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    const patch: { name?: string; role?: string; slug?: string } = {};
    if (name.trim() !== emp.name) patch.name = name.trim();
    if (role.trim() !== emp.role) patch.role = role.trim();
    if (normalizedSlug && normalizedSlug !== emp.slug) patch.slug = normalizedSlug;
    setError(null);
    setSaving(true);
    try {
      const updated = await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        patch,
      );
      toast("Employee updated", "success");
      if (updated.slug !== emp.slug) {
        navigate(`/c/${company.slug}/employees/${updated.slug}/settings/general`, {
          replace: true,
        });
        // Force a soft reload so EmployeeLayout refetches with the new slug.
        window.location.reload();
        return;
      }
      // Reflect new name/role in the sidebar without a full reload.
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Basics
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Renaming the slug updates the URL for this employee and renames its
            directory under{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              data/companies/{company.slug}/employees/
            </code>
            .
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <FormError message={error} />
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Role" value={role} onChange={(e) => setRole(e.target.value)} />
          <div>
            <Input
              label="Slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              onBlur={() => setSlug((s) => normalizeSlug(s))}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              title="Lowercase letters, digits, and single dashes"
              required
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              URL:{" "}
              <code className="font-mono">
                /c/{company.slug}/employees/{normalizedSlug || "…"}
              </code>
            </p>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Per-employee toggle for the built-in `browser` MCP server, plus the two
 * shaping settings: an allow list of host globs and an approval gate that
 * blocks form submits until a human says yes. Off by default — operator
 * opts in per employee, then narrows further with the allow list /
 * approval mode.
 */
function EmployeeBrowserAccessCard({
  company,
  emp,
}: {
  company: Company;
  emp: Employee;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(!!emp.browserEnabled);
  const [allowedHosts, setAllowedHosts] = React.useState<string>(emp.browserAllowedHosts ?? "");
  const [approval, setApproval] = React.useState<boolean>(!!emp.browserApprovalRequired);
  const [savingToggle, setSavingToggle] = React.useState(false);
  const [savingApproval, setSavingApproval] = React.useState(false);
  const [savingHosts, setSavingHosts] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    setEnabled(!!emp.browserEnabled);
    setAllowedHosts(emp.browserAllowedHosts ?? "");
    setApproval(!!emp.browserApprovalRequired);
  }, [emp.id, emp.browserEnabled, emp.browserAllowedHosts, emp.browserApprovalRequired]);

  const hostsDirty = (emp.browserAllowedHosts ?? "") !== allowedHosts;

  async function toggle(next: boolean) {
    if (savingToggle) return;
    setEnabled(next);
    setSavingToggle(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        { browserEnabled: next },
      );
      toast(next ? "Browser access enabled" : "Browser access disabled", "success");
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setEnabled(!next);
      toast((err as Error).message || "Could not update browser access", "error");
    } finally {
      setSavingToggle(false);
    }
  }

  async function toggleApproval(next: boolean) {
    if (savingApproval) return;
    setApproval(next);
    setSavingApproval(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        { browserApprovalRequired: next },
      );
      toast(
        next ? "Browser submits will require approval" : "Approval gate disabled",
        "success",
      );
    } catch (err) {
      setApproval(!next);
      toast((err as Error).message || "Could not update approval mode", "error");
    } finally {
      setSavingApproval(false);
    }
  }

  async function saveHosts() {
    if (savingHosts) return;
    setSavingHosts(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        { browserAllowedHosts: allowedHosts },
      );
      toast("Allow list saved", "success");
    } catch (err) {
      toast((err as Error).message || "Could not save allow list", "error");
    } finally {
      setSavingHosts(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Globe size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Browser access
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Wire a headless Chromium into this employee&apos;s tools. Adds{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  browser_open
                </code>
                ,{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  browser_click
                </code>
                ,{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  browser_fill
                </code>
                , and screenshot tools so the employee can read and interact
                with web pages. Off by default — narrow further with the
                allow list and approval mode below.
              </p>
            </div>
          </div>
          <label className="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={enabled}
              disabled={savingToggle}
              onChange={(e) => toggle(e.target.checked)}
            />
            <div className="h-5 w-9 rounded-full bg-slate-200 transition peer-checked:bg-indigo-500 peer-disabled:opacity-50 dark:bg-slate-700 dark:peer-checked:bg-indigo-500" />
            <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
          </label>
        </div>

        {enabled && (
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                Allow list
              </label>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Newline-separated host globs (e.g.{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  *.gmail.com
                </code>
                ,{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  notion.so
                </code>
                ). Lines starting with{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  #
                </code>{" "}
                are comments. Leave blank for no restriction.
              </p>
              <textarea
                rows={4}
                value={allowedHosts}
                onChange={(e) => setAllowedHosts(e.target.value)}
                placeholder="# Examples:&#10;*.gmail.com&#10;github.com"
                className="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  variant="secondary"
                  disabled={!hostsDirty || savingHosts}
                  onClick={saveHosts}
                >
                  {savingHosts ? "Saving…" : "Save allow list"}
                </Button>
              </div>
            </div>

            <div className="flex items-start justify-between gap-4 border-t border-slate-100 pt-3 dark:border-slate-800">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Require approval for form submits
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Calls to{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    browser_submit
                  </code>{" "}
                  queue an Approval row instead of firing immediately. The
                  employee resumes via{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    browser_resume
                  </code>{" "}
                  once a human approves.
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={approval}
                  disabled={savingApproval}
                  onChange={(e) => toggleApproval(e.target.checked)}
                />
                <div className="h-5 w-9 rounded-full bg-slate-200 transition peer-checked:bg-indigo-500 peer-disabled:opacity-50 dark:bg-slate-700 dark:peer-checked:bg-indigo-500" />
                <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
              </label>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function ModelSettingsPage() {
  const { company, emp } = useCtx();
  return <EmployeeModelSection company={company} emp={emp} />;
}

/**
 * Renders the full per-employee model surface. An employee can register
 * several models and keep exactly one active; this lists them, lets the
 * operator add more, switch the active one, sign each in, and reconfigure or
 * remove them. Exported so the onboarding wizard can drop it in as a step
 * without duplicating the state machine.
 */
export function EmployeeModelSection({ company, emp }: { company: Company; emp: Employee }) {
  const [models, setModels] = React.useState<AIModel[] | undefined>(undefined);
  const [adding, setAdding] = React.useState(false);

  const reload = React.useCallback(async () => {
    const list = await api.get<AIModel[]>(
      `/api/companies/${company.id}/employees/${emp.id}/models`,
    );
    setModels(list);
  }, [company.id, emp.id]);

  React.useEffect(() => {
    reload().catch(() => setModels([]));
  }, [reload]);

  if (models === undefined) return <Spinner />;

  // No models yet — straight to the first-model setup card.
  if (models.length === 0) {
    return <ModelSetup company={company} emp={emp} onSaved={reload} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {emp.name}&apos;s models
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {models.length === 1
              ? "One brain registered. Add another to switch between them any time."
              : `${models.length} brains registered — the active one answers chats and runs routines.`}
          </div>
        </div>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add model
          </Button>
        )}
      </div>

      {adding && (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Add a model
              </div>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              The model you add becomes active right away. You can switch back any time.
            </div>
            <ModelForm
              mode="create"
              initial={{ provider: "anthropic", model: "claude-opus-4-6", authMode: "apikey" }}
              company={company}
              emp={emp}
              onSaved={() => {
                setAdding(false);
                reload();
              }}
              submitLabel="Add model"
            />
          </CardBody>
        </Card>
      )}

      {models.map((m) => (
        <ModelCard key={m.id} company={company} emp={emp} model={m} onChanged={reload} />
      ))}
    </div>
  );
}

function ModelSetup({
  company,
  emp,
  onSaved,
}: {
  company: Company;
  emp: Employee;
  onSaved: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Connect a brain for {emp.name}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Each AI Employee signs into their own provider — pick one and connect it.
          </div>
        </div>
        <ModelForm
          mode="create"
          initial={{ provider: "anthropic", model: "claude-opus-4-6", authMode: "apikey" }}
          company={company}
          emp={emp}
          onSaved={onSaved}
          submitLabel="Continue"
        />
      </CardBody>
    </Card>
  );
}

function ModelForm({
  mode,
  editModelId,
  initial,
  company,
  emp,
  onSaved,
  submitLabel,
}: {
  /** "create" POSTs a new model row; "edit" PUTs an existing one. */
  mode: "create" | "edit";
  /** Required when mode is "edit" — the row being reconfigured. */
  editModelId?: string;
  initial: { provider: Provider; model: string; authMode: AuthMode };
  company: Company;
  emp: Employee;
  onSaved: () => void;
  submitLabel: string;
}) {
  const [provider, setProvider] = React.useState<Provider>(initial.provider);
  const [modelStr, setModelStr] = React.useState(initial.model);
  const [saving, setSaving] = React.useState(false);
  // Custom-endpoint inputs live on the same form so onboarding is one submit.
  const [baseURL, setBaseURL] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const { toast } = useToast();

  const isCustom = provider === "custom";
  const authMode: AuthMode = isCustom ? "customEndpoint" : "apikey";

  const onProvider = (p: Provider) => {
    setProvider(p);
    setModelStr(PROVIDER_DEFAULTS[p].model);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        const base = `/api/companies/${company.id}/employees/${emp.id}/models`;
        try {
          if (isCustom) {
            // Two-call save: create/update the row in customEndpoint mode (the
            // schema requires a non-empty model — the model id satisfies it),
            // then the encrypted endpoint config that flips status to connected.
            const payload = { provider: "custom", model: modelId || "custom", authMode };
            const saved =
              mode === "create"
                ? await api.post<AIModel>(base, payload)
                : await api.put<AIModel>(`${base}/${editModelId}`, payload);
            await api.post(`${base}/${saved.id}/custom-endpoint`, {
              baseURL,
              modelId,
              ...(apiKey ? { apiKey } : {}),
            });
            setApiKey("");
            onSaved();
            return;
          }
          const payload = { provider, model: modelStr, authMode };
          if (mode === "create") {
            await api.post<AIModel>(base, payload);
          } else {
            await api.put<AIModel>(`${base}/${editModelId}`, payload);
          }
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className={isCustom ? "" : "grid gap-3 sm:grid-cols-2"}>
        <Select
          label="Provider"
          value={provider}
          onChange={(e) => onProvider(e.target.value as Provider)}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI (GPT)</option>
          <option value="custom">Custom OpenAI-compatible endpoint</option>
        </Select>
        {!isCustom && (
          <Input
            label="Model"
            value={modelStr}
            onChange={(e) => setModelStr(e.target.value)}
            required
          />
        )}
      </div>
      {isCustom && (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Base URL"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder={baseUrlPlaceholder(provider)}
              required
            />
            <Input
              label="Model id"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="qwen2.5-coder:32b"
              required
            />
          </div>
          <Input
            label="API key (optional — most local servers ignore this)"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="leave blank if not needed"
          />
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Point this employee at a self-hosted OpenAI-compatible server —
            Ollama, vLLM, llama.cpp, LM Studio. Base URL + key are stored
            encrypted at rest.
          </div>
        </div>
      )}
      {!isCustom && (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {provider === "anthropic"
            ? "Claude via the Anthropic API. Add the API key after saving."
            : "GPT via the OpenAI API. Add the API key after saving."}
        </div>
      )}
      <div>
        <Button
          type="submit"
          disabled={
            saving ||
            (isCustom && (baseURL.trim().length === 0 || modelId.trim().length === 0))
          }
        >
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * One model in the employee's roster: status, an active toggle, the connect
 * panel (API key or custom endpoint), and a reconfigure disclosure. The active
 * model is ringed and badged; any non-active model gets a "Make active" button.
 */
function ModelCard({
  company,
  emp,
  model,
  onChanged,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const connected = model.status === "connected";
  const [activating, setActivating] = React.useState(false);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models`;

  async function activate() {
    setActivating(true);
    try {
      await api.post(`${base}/${model.id}/activate`);
      toast(`${emp.name} now runs on ${model.provider} · ${model.model}`, "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setActivating(false);
    }
  }

  async function disconnect() {
    if (connected) {
      const ok = await dialog.confirm({
        title: `Remove this model?`,
        message: `${emp.name}'s stored credentials for ${model.provider} · ${model.model} will be removed. You can reconnect any time.`,
        confirmLabel: "Remove",
        variant: "danger",
      });
      if (!ok) return;
    }
    try {
      await api.del(`${base}/${model.id}`);
      toast(connected ? "Model removed" : "Removed", "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const subtitle = (() => {
    if (connected) {
      if (model.authMode === "customEndpoint") {
        return model.customEndpointHost
          ? `Pointed at ${model.customEndpointHost}`
          : "Custom endpoint configured";
      }
      return `Authenticated with ${model.apiKeyEnv ?? "API"} key`;
    }
    if (model.authMode === "customEndpoint") {
      return "Enter the server's base URL and model id below to connect.";
    }
    return `No ${model.apiKeyEnv ?? "API"} key on file yet — paste one below to connect.`;
  })();

  return (
    <Card
      className={
        model.isActive ? "ring-1 ring-indigo-300 dark:ring-indigo-500/40" : undefined
      }
    >
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {model.provider} · {model.model}
              </span>
              <StatusBadge connected={connected} />
              {model.isActive && <ActiveBadge />}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {subtitle}
              {model.connectedAt && connected && (
                <> · connected {new Date(model.connectedAt).toLocaleString()}</>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!model.isActive && (
              <Button size="sm" variant="ghost" onClick={activate} disabled={activating}>
                {activating ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                Make active
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={disconnect}>
              <Unplug size={14} /> {connected ? "Remove" : "Cancel"}
            </Button>
          </div>
        </div>

        {!connected && model.authMode === "apikey" && (
          <ApiKeyPanel company={company} emp={emp} model={model} onSaved={onChanged} />
        )}
        {model.authMode === "customEndpoint" && (
          <CustomEndpointPanel
            company={company}
            emp={emp}
            model={model}
            onSaved={onChanged}
          />
        )}

        <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
          <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">
            Change provider, model, or endpoint
          </summary>
          <div className="mt-3">
            <ModelForm
              mode="edit"
              editModelId={model.id}
              initial={{ provider: model.provider, model: model.model, authMode: model.authMode }}
              company={company}
              emp={emp}
              onSaved={onChanged}
              submitLabel="Save changes"
            />
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300">
        <Check size={10} /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300">
      <Loader2 size={10} className="animate-spin" /> Waiting
    </span>
  );
}

function ActiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300">
      <BrainCircuit size={10} /> Active
    </span>
  );
}

function apiKeyPlaceholder(p: Provider): string {
  return p === "openai" ? "sk-…" : "sk-ant-…";
}

function ApiKeyPanel({
  company,
  emp,
  model,
  onSaved,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onSaved: () => void;
}) {
  const [key, setKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.post(
            `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/apikey`,
            { apiKey: key },
          );
          setKey("");
          toast("API key saved", "success");
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <Input
        label={model.apiKeyEnv ?? "API key"}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={apiKeyPlaceholder(model.provider)}
        required
      />
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Stored encrypted at rest. Removed on disconnect.
      </div>
      <div>
        <Button type="submit" disabled={saving || key.length === 0}>
          {saving ? "Saving…" : "Save key"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Form for the customEndpoint auth mode. Three fields: base URL, model id,
 * optional API key. Base URL is the load-bearing signal: until it's saved the
 * model row stays in "Waiting" status even though provider + auth are set.
 */
function CustomEndpointPanel({
  company,
  emp,
  model,
  onSaved,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onSaved: () => void;
}) {
  const [baseURL, setBaseURL] = React.useState("");
  const [modelId, setModelId] = React.useState(model.customEndpointModelId ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const connected = model.status === "connected";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.post(
            `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/custom-endpoint`,
            {
              baseURL,
              modelId,
              ...(apiKey ? { apiKey } : {}),
            },
          );
          setApiKey("");
          toast(connected ? "Endpoint updated" : "Endpoint connected", "success");
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Base URL"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder={baseUrlPlaceholder(model.provider)}
          required
        />
        <Input
          label="Model id"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="qwen2.5-coder:32b"
          required
        />
      </div>
      <Input
        label={`API key (optional — most local servers ignore this)`}
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={model.customEndpointHasApiKey ? "•••••••• (replace to update)" : "leave blank if not needed"}
      />
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Point this employee at a self-hosted OpenAI-compatible server. Base URL +
        key are stored encrypted at rest.
      </div>
      <div>
        <Button type="submit" disabled={saving || baseURL.length === 0 || modelId.length === 0}>
          {saving ? "Saving…" : connected ? "Update endpoint" : "Save & connect"}
        </Button>
      </div>
    </form>
  );
}

function baseUrlPlaceholder(_provider: Provider): string {
  // Ollama's port is the easiest sanity check; vLLM and llama-server are also
  // documented in /docs. host.docker.internal reaches the host from the container.
  return "http://host.docker.internal:11434/v1";
}

function WebhookField({
  enabled,
  token,
  routineId,
  onToggle,
}: {
  enabled: boolean;
  token: string | null;
  routineId: string;
  onToggle: (enabled: boolean) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const url =
    enabled && token
      ? `${window.location.origin}/api/webhooks/r/${routineId}/${token}`
      : null;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:bg-slate-900 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          Trigger via incoming webhook
        </label>
        {enabled && token && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await onToggle(false);
              await onToggle(true);
              toast("Webhook token regenerated", "success");
            }}
          >
            Regenerate token
          </Button>
        )}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">
        External systems POST here to fire this routine. The URL itself is the
        credential — keep it secret.
      </div>
      {url && (
        <div className="flex items-center gap-1">
          <code className="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-800 dark:bg-slate-900 dark:text-slate-100">
            {url}
          </code>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const ok = await copyToClipboard(url);
              toast(ok ? "Copied" : "Could not access clipboard", ok ? "success" : "error");
            }}
          >
            <Copy size={12} />
          </Button>
        </div>
      )}
    </div>
  );
}

const JOURNAL_KIND_STYLE: Record<JournalKind, string> = {
  run: "bg-sky-50 text-sky-700 border-sky-200",
  note: "bg-slate-50 text-slate-700 border-slate-200",
  system: "bg-violet-50 text-violet-700 border-violet-200",
};

/**
 * Per-employee journal. Auto-emits a row for every routine run; humans add
 * free-form notes. The product intent is that future routine prompts can
 * feed the last N entries back into the CLI — but v1 just makes the diary
 * visible so you can audit what the employee has actually done.
 */
export function JournalPage() {
  const { company, emp } = useCtx();
  const [entries, setEntries] = React.useState<JournalEntryT[] | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/employees/${emp.id}`;

  async function reload() {
    try {
      const list = await api.get<JournalEntryT[]>(`${base}/journal`);
      setEntries(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setEntries([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      const created = await api.post<JournalEntryT>(`${base}/journal`, {
        title: t,
        body: body.trim(),
      });
      setEntries((prev) => (prev ? [created, ...prev] : [created]));
      setTitle("");
      setBody("");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete this entry?",
      message: "This journal entry will be permanently removed.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/journal/${id}`);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function updateEntry(
    id: string,
    patch: { title?: string; body?: string },
  ): Promise<boolean> {
    try {
      const updated = await api.patch<JournalEntryT>(`${base}/journal/${id}`, patch);
      setEntries((prev) =>
        prev ? prev.map((e) => (e.id === id ? updated : e)) : prev,
      );
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    }
  }

  return (
    <>
      <TopBar title="Journal" />
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            A daily diary of what this employee did. Routine runs land here automatically.
            <strong className="text-slate-700 dark:text-slate-200">
              {" "}The last 7 days are auto-injected into every chat and routine run
            </strong>
            {" "}— they&apos;re how the employee remembers what happened yesterday.
          </p>
          <form onSubmit={addNote} className="mt-3 flex flex-col gap-2">
            <Input
              label="Add note"
              placeholder="What should this employee remember?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Optional detail…"
              className="resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            />
            <div>
              <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
                <BookText size={14} /> {saving ? "Saving…" : "Add entry"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4">
        {entries === null ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <EmptyState
            title="No entries yet"
            description="Routine runs will appear here automatically, or add a note above."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <JournalEntryRow
                key={e.id}
                entry={e}
                onSave={(patch) => updateEntry(e.id, patch)}
                onDelete={() => remove(e.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function JournalEntryRow({
  entry,
  onSave,
  onDelete,
}: {
  entry: JournalEntryT;
  onSave: (patch: { title?: string; body?: string }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(entry.title);
  const [draftBody, setDraftBody] = React.useState(entry.body);
  const [saving, setSaving] = React.useState(false);

  function start() {
    setDraftTitle(entry.title);
    setDraftBody(entry.body);
    setEditing(true);
  }

  async function save() {
    const t = draftTitle.trim();
    if (!t) return;
    setSaving(true);
    const ok = await onSave({ title: t, body: draftBody });
    setSaving(false);
    if (ok) setEditing(false);
  }

  return (
    <li>
      <Card>
        <CardBody className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={
                  "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                  JOURNAL_KIND_STYLE[entry.kind]
                }
              >
                {entry.kind}
              </span>
              {editing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
              ) : (
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {entry.title}
                </div>
              )}
            </div>
            {editing ? (
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={3}
                placeholder="Optional detail…"
                className="mt-2 w-full resize-none rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              />
            ) : (
              entry.body && (
                <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
                  {entry.body}
                </div>
              )
            )}
            <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              {new Date(entry.createdAt).toLocaleString()}
            </div>
            {editing && (
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  onClick={save}
                  disabled={saving || !draftTitle.trim()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
          {!editing && (
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={start}
                aria-label="Edit entry"
              >
                <Edit3 size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                aria-label="Delete entry"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </li>
  );
}

/**
 * Per-employee Memory. Durable, short "facts" or "preferences" injected into
 * every chat and routine run — distinct from the free-form Soul document and
 * the append-only Journal. Both humans and the AI itself can write here (the
 * AI via the `add_memory` MCP tool).
 */
export function MemoryPage() {
  const { company, emp } = useCtx();
  const [items, setItems] = React.useState<MemoryItem[] | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/employees/${emp.id}`;

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<MemoryItem[]>(`${base}/memory`);
      setItems(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setItems([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      const created = await api.post<MemoryItem>(`${base}/memory`, {
        title: t,
        body: body.trim(),
      });
      setItems((prev) => (prev ? [...prev, created] : [created]));
      setTitle("");
      setBody("");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function update(
    id: string,
    patch: { title?: string; body?: string },
  ): Promise<boolean> {
    try {
      const updated = await api.patch<MemoryItem>(`${base}/memory/${id}`, patch);
      setItems((prev) => (prev ? prev.map((x) => (x.id === id ? updated : x)) : prev));
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    }
  }

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete this memory?",
      message: "The employee will stop recalling this fact on their next spawn.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/memory/${id}`);
      setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar title="Memory" />
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Durable facts and preferences this employee should recall in
            <strong className="text-slate-700 dark:text-slate-200"> every conversation and routine run</strong>
            . Unlike the free-form Soul, each memory item is a single short fact you can add, edit, or delete without touching the others. {emp.name} can also curate these themselves via MCP tools.
          </p>
          <form onSubmit={add} className="mt-3 flex flex-col gap-2">
            <Input
              label="New memory"
              placeholder="e.g. Prefers ARR over MRR when talking about revenue"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder="Optional elaboration…"
              className="resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600 dark:text-slate-100"
            />
            <div>
              <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
                <Plus size={14} /> {saving ? "Saving…" : "Add memory"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4">
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No memories yet"
            description={`Add the first durable fact you want ${emp.name} to recall in every future chat or routine.`}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((m) => (
              <MemoryRow
                key={m.id}
                item={m}
                onSave={(patch) => update(m.id, patch)}
                onDelete={() => remove(m.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function MemoryRow({
  item,
  onSave,
  onDelete,
}: {
  item: MemoryItem;
  onSave: (patch: { title?: string; body?: string }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(item.title);
  const [draftBody, setDraftBody] = React.useState(item.body);
  const [saving, setSaving] = React.useState(false);

  function start() {
    setDraftTitle(item.title);
    setDraftBody(item.body);
    setEditing(true);
  }

  async function save() {
    const t = draftTitle.trim();
    if (!t) return;
    setSaving(true);
    const ok = await onSave({ title: t, body: draftBody });
    setSaving(false);
    if (ok) setEditing(false);
  }

  return (
    <li>
      <Card>
        <CardBody className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Brain size={12} className="shrink-0 text-indigo-500 dark:text-indigo-400" />
              {editing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
              ) : (
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {item.title}
                </div>
              )}
            </div>
            {editing ? (
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={3}
                placeholder="Optional elaboration…"
                className="mt-2 w-full resize-none rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              />
            ) : (
              item.body && (
                <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
                  {item.body}
                </div>
              )
            )}
            <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              Added {new Date(item.createdAt).toLocaleString()}
              {item.updatedAt && item.updatedAt !== item.createdAt && (
                <> · updated {new Date(item.updatedAt).toLocaleString()}</>
              )}
            </div>
            {editing && (
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  onClick={save}
                  disabled={saving || !draftTitle.trim()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  <X size={12} /> Cancel
                </Button>
              </div>
            )}
          </div>
          {!editing && (
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={start}
                aria-label="Edit memory"
              >
                <Edit3 size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                aria-label="Delete memory"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </li>
  );
}

/**
 * Per-employee MCP (Model Context Protocol) server list. Adding a server
 * writes its config into `.mcp.json` at the employee's workspace root on
 * the next spawn, so tools show up natively to the model.
 */
export function McpPage() {
  const { company, emp } = useCtx();
  const [servers, setServers] = React.useState<McpServer[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();
  const base = `/api/companies/${company.id}/employees/${emp.id}/mcp`;

  async function reload() {
    try {
      const list = await api.get<McpServer[]>(base);
      setServers(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setServers([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete MCP server?",
      message: "This server will no longer be materialized into .mcp.json for this employee.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/${id}`);
      setServers((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar
        title="MCP servers"
        right={<Button onClick={() => setAdding(true)}>Add server</Button>}
      />
      <div className="mb-3">
        <ExternalMcpPanel company={company} emp={emp} />
      </div>
      {servers === null ? (
        <Spinner />
      ) : servers.length === 0 ? (
        <EmptyState
          title="No MCP servers yet"
          description="Attach tools via the Model Context Protocol so this employee can use them from any provider CLI."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((s) => (
            <li key={s.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Plug size={14} className="text-slate-500 dark:text-slate-400" />
                      <div className="font-medium">{s.name}</div>
                      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300">
                        {s.transport}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {s.transport === "stdio"
                        ? `${s.command ?? ""}${s.args.length ? ` ${s.args.join(" ")}` : ""}`
                        : s.url}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(s.id)}
                    aria-label="Delete MCP server"
                  >
                    <Trash2 size={12} />
                  </Button>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <NewMcpModal
          company={company}
          emp={emp}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Read-only panel on the MCP tab showing the employee's external MCP endpoint.
 * An outside harness (Claude Desktop, Cursor, a custom agent) points its
 * Streamable-HTTP MCP client at this URL and authenticates with a Genosyn API
 * key to drive this employee's built-in `genosyn` tools from outside the app.
 */
function ExternalMcpPanel({ company, emp }: { company: Company; emp: Employee }) {
  const [copied, setCopied] = React.useState(false);
  const url = `${window.location.origin}/api/companies/${company.id}/employees/${emp.id}/mcp/connect`;
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <ExternalLink
            size={14}
            className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Connect an external harness</div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Point any MCP client — Claude Desktop, Cursor, or your own agent —
              at the URL below to use {emp.name}
              {"’"}s built-in Genosyn tools over Streamable HTTP.
              Authenticate with an{" "}
              <NavLink
                to={`/c/${company.slug}/settings/api-keys`}
                className="underline hover:text-slate-700 dark:hover:text-slate-200"
              >
                API key
              </NavLink>{" "}
              as a Bearer token.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
            {url}
          </code>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              const ok = await copyToClipboard(url);
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function NewMcpModal({
  company,
  emp,
  onClose,
  onCreated,
}: {
  company: Company;
  emp: Employee;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<McpTransport>("stdio");
  const [command, setCommand] = React.useState("");
  const [argsLine, setArgsLine] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [envLines, setEnvLines] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      // Space-separated args on one line — MCP command lines are typically
      // short. Users with complex args can paste them with quoting; we keep
      // the input simple on purpose.
      const args = argsLine.trim() ? argsLine.trim().split(/\s+/) : [];
      const env: Record<string, string> = {};
      for (const line of envLines.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
      }
      const body: Record<string, unknown> = { name: name.trim(), transport };
      if (transport === "stdio") {
        body.command = command.trim();
        if (args.length) body.args = args;
      } else {
        body.url = url.trim();
      }
      if (Object.keys(env).length) body.env = env;
      await api.post(
        `/api/companies/${company.id}/employees/${emp.id}/mcp`,
        body,
      );
      onCreated();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add MCP server" size="lg">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. github"
          required
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Transport</label>
          <div className="flex gap-2">
            {(["stdio", "http"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  checked={transport === t}
                  onChange={() => setTransport(t)}
                />
                {t}
              </label>
            ))}
          </div>
        </div>
        {transport === "stdio" ? (
          <>
            <Input
              label="Command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx"
              required
            />
            <Input
              label="Args (space-separated)"
              value={argsLine}
              onChange={(e) => setArgsLine(e.target.value)}
              placeholder="e.g. -y @modelcontextprotocol/server-github"
            />
          </>
        ) : (
          <Input
            label="URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            required
          />
        )}
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Env (KEY=value, one per line)
          </label>
          <textarea
            value={envLines}
            onChange={(e) => setEnvLines(e.target.value)}
            rows={3}
            className="resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            placeholder="GITHUB_TOKEN=ghp_…"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Add server"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
