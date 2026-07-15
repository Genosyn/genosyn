import React from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { api, Company, Routine, Run, RunLog, RunStatus } from "../../lib/api";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

/**
 * Shared rendering for Runs — one execution of a Routine. Lives here rather
 * than beside a page because the Routines list, the routine detail page, and
 * the live-tail modal all render the same status vocabulary, and a run that
 * looks `failed` in one place must not look `skipped` in another.
 */

const RUN_STATUS_STYLE: Record<RunStatus, string> = {
  running:
    "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
  completed:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  failed:
    "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  skipped:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  timeout:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30",
};

/**
 * The status word itself is the label — no display-name map. `skipped` is the
 * one that reads oddly at first: it means the routine fired but had no model
 * connected, so nothing ran.
 */
export function RunStatusChip({
  status,
  size = "sm",
}: {
  status: RunStatus;
  size?: "xs" | "sm";
}) {
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 rounded border font-medium uppercase tracking-wide " +
        (size === "xs" ? "px-1.5 py-0.5 text-[10px] " : "px-2 py-0.5 text-xs ") +
        RUN_STATUS_STYLE[status]
      }
    >
      {status === "running" && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  );
}

/** Wall-clock length of a run. Runs carry no duration column — it's derived. */
export function formatDuration(started: string, finished: string | null): string {
  if (!finished) return "—";
  const ms = new Date(finished).getTime() - new Date(started).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

/** Relative time for list rows — "3m ago", "yesterday". Absolute date on hover. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Time until a future instant — "in 4h". Used for `nextRunAt`. */
export function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const s = Math.round(ms / 1000);
  if (s < 60) return "in <1m";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.round(h / 24);
  return `in ${d}d`;
}

/**
 * The captured stdout/stderr of a run. Server hard-caps the stored log at
 * 256KB and serves the head, so the truncation banner is load-bearing —
 * without it a clipped log looks like a run that stopped early.
 */
export function RunLogPane({
  log,
  loading,
  placeholder = "(empty log)",
  onScroll,
  preRef,
  className = "h-full",
}: {
  log: RunLog | null;
  loading?: boolean;
  placeholder?: string;
  onScroll?: () => void;
  preRef?: React.RefObject<HTMLPreElement>;
  className?: string;
}) {
  return (
    <div className="flex-1 overflow-hidden rounded-lg border border-slate-200 bg-slate-950 dark:border-slate-700">
      {loading ? (
        <div className="flex h-full items-center justify-center text-xs text-slate-400">
          <Loader2 size={14} className="mr-2 animate-spin" /> Loading log…
        </div>
      ) : log === null ? (
        <div className="flex h-full items-center justify-center text-xs text-slate-500">
          {placeholder}
        </div>
      ) : (
        <pre
          ref={preRef}
          onScroll={onScroll}
          className={
            "overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-100 " +
            className
          }
        >
          {log.truncated && (
            <div className="mb-2 text-amber-400">
              [log truncated — first 256KB of {log.size} bytes]
            </div>
          )}
          {log.content || <span className="text-slate-500">{placeholder}</span>}
        </pre>
      )}
    </div>
  );
}

/**
 * Live tail for a run that was just kicked off. Polls `/runs/:runId/log` until
 * the server reports a terminal status; that endpoint serves the in-memory
 * buffer while the child is alive and the persisted log once it finalizes, so
 * one poll drives the whole modal — no separate "is it done" probe.
 */
export function RunLiveModal({
  company,
  routine,
  run: initialRun,
  onClose,
  onRetry,
}: {
  company: Company;
  routine: Pick<Routine, "id" | "name">;
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
        if (next.status === "running") timer = setTimeout(tick, 1200);
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

  // Follow the tail, unless the user scrolled away from the bottom themselves
  // — reading mid-log shouldn't get yanked out from under them.
  React.useEffect(() => {
    const el = preRef.current;
    if (!el || userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [log?.content]);

  function handleScroll() {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    userScrolledRef.current = !atBottom;
  }

  return (
    <Modal open onClose={onClose} title={`Run: ${routine.name}`} size="xl">
      <div className="flex flex-col gap-3" style={{ minHeight: 420 }}>
        <div className="flex items-center gap-2 text-xs">
          <RunStatusChip status={status} />
          {log?.exitCode !== null && log?.exitCode !== undefined && (
            <span className="text-slate-500 dark:text-slate-400">exit {log.exitCode}</span>
          )}
          {log?.startedAt && (
            <span className="text-slate-400 dark:text-slate-500">
              {formatDuration(
                log.startedAt,
                log.finishedAt ?? (isTerminal ? new Date().toISOString() : null),
              )}
            </span>
          )}
          {log?.live && <span className="text-slate-400 dark:text-slate-500">live</span>}
          {error && <span className="text-rose-500 dark:text-rose-400">{error}</span>}
        </div>
        <RunLogPane
          log={log}
          preRef={preRef}
          onScroll={handleScroll}
          placeholder={log === null ? "Starting…" : "Waiting for output…"}
          className="max-h-[60vh] min-h-[360px]"
        />
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
