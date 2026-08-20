import React from "react";
import { AlertTriangle, Ban, Download, Loader2, Lock, RotateCcw, Video } from "lucide-react";
import { api, Company, Routine, Run, RunBrowserRecording, RunLog, RunStatus } from "../../lib/api";
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
  interrupted:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30",
};

/**
 * The status word itself is the label — no display-name map. Two read oddly at
 * first: `skipped` means the routine fired but had no model connected, so
 * nothing ran; `interrupted` means the server stopped mid-run, so we know what
 * the transcript captured and nothing about what happened after.
 */
export function RunStatusChip({ status, size = "sm" }: { status: RunStatus; size?: "xs" | "sm" }) {
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
 * How late a schedule is, or null if it isn't late. The counterpart to
 * {@link timeUntil}, which flattens every past instant to a quiet "due now" —
 * so a routine that missed twelve occurrences reads identically to one firing
 * in a second. `graceMs` keeps the ordinary gap between a slot coming due and
 * the heartbeat picking it up from looking like a problem.
 */
export function overdueFor(iso: string, graceMs = 5 * 60_000): string | null {
  const late = Date.now() - new Date(iso).getTime();
  if (late <= graceMs) return null;
  const m = Math.round(late / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
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

/** True while another log poll can reveal a terminal Run or a playable video. */
export function runLogNeedsPolling(log: RunLog): boolean {
  return (
    log.status === "running" ||
    (log.browserRecordings ?? []).some(
      (recording) => recording.status === "recording" || recording.status === "finalizing",
    )
  );
}

/** `2.4 MB` — recording metadata without making the browser fetch the video. */
function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function recordingStatusLabel(recording: RunBrowserRecording): string {
  if (recording.status === "recording") return "Recording";
  if (recording.status === "finalizing") return "Finalizing";
  if (recording.status === "failed") return "Failed";
  if (recording.status === "restricted") return "Withheld";
  return "Ready";
}

/**
 * Saved visual browser evidence for a Run. Browser-enabled work can delegate,
 * so the selector handles several independent BrowserSessions without making
 * the common one-recording case feel like an artifact manager.
 */
export function RunBrowserRecordingsPane({
  companyId,
  runId,
  recordings,
  className = "min-h-[360px] max-h-[60vh]",
}: {
  companyId: string;
  runId: string;
  recordings: RunBrowserRecording[];
  className?: string;
}) {
  const [selectedId, setSelectedId] = React.useState(recordings[0]?.id ?? "");
  const [playbackErrorId, setPlaybackErrorId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelectedId((current) =>
      recordings.some((recording) => recording.id === current)
        ? current
        : (recordings[0]?.id ?? ""),
    );
  }, [recordings]);

  const selected =
    recordings.find((recording) => recording.id === selectedId) ?? recordings[0] ?? null;

  React.useEffect(() => {
    setPlaybackErrorId(null);
  }, [companyId, runId, selected?.id, selected?.status]);

  if (!selected) return null;

  const recordingUrl = `/api/companies/${companyId}/runs/${runId}/browser-recordings/${selected.id}`;
  const size = selected.status === "ready" ? formatBytes(selected.sizeBytes) : null;
  const duration =
    selected.startedAt && selected.finishedAt
      ? formatDuration(selected.startedAt, selected.finishedAt)
      : null;
  const selectedNumber = recordings.findIndex((recording) => recording.id === selected.id) + 1;
  const playbackFailed = selected.status === "ready" && playbackErrorId === selected.id;

  return (
    <section
      aria-label="Browser recording"
      className={
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950 " +
        className
      }
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <Video size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Browser {recordings.length === 1 ? "recording" : "recordings"}
        </span>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-[11px] text-slate-400 dark:text-slate-500"
        >
          {playbackFailed ? "Playback unavailable" : recordingStatusLabel(selected)}
          {duration ? ` · ${duration}` : ""}
          {size ? ` · ${size}` : ""}
        </span>
        <span className="min-w-0 flex-1" />
        {selected.status === "ready" && (
          <a
            href={`${recordingUrl}?disposition=attachment`}
            download={selected.filename ?? undefined}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
          >
            <Download size={12} /> Download
          </a>
        )}
      </header>

      {recordings.length > 1 && (
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900"
          aria-label="Choose a browser recording"
        >
          {recordings.map((recording, index) => (
            <button
              key={recording.id}
              type="button"
              onClick={() => setSelectedId(recording.id)}
              aria-pressed={recording.id === selected.id}
              aria-label={`Browser recording ${index + 1}, ${recordingStatusLabel(recording)}`}
              className={
                "shrink-0 rounded px-2 py-1 text-[11px] font-medium transition " +
                (recording.id === selected.id
                  ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
              }
            >
              Browser {index + 1}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-950">
        {playbackFailed ? (
          <RecordingState
            icon={<AlertTriangle size={24} />}
            title="Playback unavailable"
            body={
              <>
                This browser could not play the saved video. Try{" "}
                <a
                  href={`${recordingUrl}?disposition=attachment`}
                  download={selected.filename ?? undefined}
                  className="font-medium text-indigo-300 underline underline-offset-2 hover:text-indigo-200"
                >
                  downloading the MP4
                </a>
                {" "}instead.
              </>
            }
          />
        ) : selected.status === "ready" ? (
          <video
            key={selected.id}
            controls
            playsInline
            preload="metadata"
            aria-label={
              recordings.length === 1
                ? "Browser recording playback"
                : `Browser recording ${selectedNumber} playback`
            }
            onError={() => setPlaybackErrorId(selected.id)}
            onLoadedMetadata={() => setPlaybackErrorId(null)}
            className="max-h-full w-full bg-black object-contain"
          >
            <source src={recordingUrl} type={selected.mimeType ?? "video/mp4"} />
            Your browser cannot play this recording. Use Download instead.
          </video>
        ) : selected.status === "recording" || selected.status === "finalizing" ? (
          <RecordingState
            icon={<Loader2 size={24} className="animate-spin" />}
            title={
              selected.status === "recording"
                ? "Recording browser activity…"
                : "Finalizing browser recording…"
            }
            body={
              selected.status === "recording"
                ? "Playback will be available after this browser session finishes."
                : "The Run has finished. Genosyn is preparing the video for playback."
            }
          />
        ) : selected.status === "restricted" ? (
          <RecordingState
            icon={<Lock size={24} />}
            title="Recording withheld"
            body="This recording contains protected browser data or is not available to this Member. The Run log remains available."
          />
        ) : (
          <RecordingState
            icon={<AlertTriangle size={24} />}
            title="Recording unavailable"
            body="The browser recording could not be saved. The Run log remains available."
          />
        )}
      </div>
    </section>
  );
}

function RecordingState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-2 px-6 py-10 text-center text-slate-400">
      {icon}
      <div className="text-sm font-medium text-slate-200">{title}</div>
      <p className="text-xs leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}

/**
 * Live tail for a run that was just kicked off. Polls `/runs/:runId/log` until
 * the server reports a terminal status and every browser recording has left
 * its transitional state. That endpoint serves the in-memory buffer while the
 * child is alive and the persisted log once it finalizes, so one poll drives
 * the whole modal — no separate status or recording probe.
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
        if (runLogNeedsPolling(next)) timer = setTimeout(tick, 1200);
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

  // Stop an automatic re-attempt without pausing the whole routine — the way
  // out when a human has decided to fix this failure by hand.
  async function cancelRetry() {
    try {
      await api.post(`/api/companies/${company.id}/runs/${initialRun.id}/cancel-retry`, {});
      setLog((cur) => (cur ? { ...cur, retryAt: null } : cur));
    } catch (err) {
      setError((err as Error).message);
    }
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
          {log?.attempt !== undefined && log.attempt > 1 && (
            <span className="text-slate-500 dark:text-slate-400">attempt {log.attempt}</span>
          )}
          {log?.retryAt && (
            <span className="text-slate-500 dark:text-slate-400">
              retry {timeUntil(log.retryAt)}
            </span>
          )}
          {error && <span className="text-rose-500 dark:text-rose-400">{error}</span>}
        </div>
        <div
          className={
            "grid min-w-0 flex-1 gap-3 " +
            ((log?.browserRecordings?.length ?? 0) > 0 ? "xl:grid-cols-2" : "")
          }
        >
          <RunLogPane
            log={log}
            preRef={preRef}
            onScroll={handleScroll}
            placeholder={log === null ? "Starting…" : "Waiting for output…"}
            className="max-h-[60vh] min-h-[360px]"
          />
          {(log?.browserRecordings?.length ?? 0) > 0 && (
            <RunBrowserRecordingsPane
              companyId={company.id}
              runId={initialRun.id}
              recordings={log?.browserRecordings ?? []}
            />
          )}
        </div>
        <div className="flex justify-end gap-2">
          {log?.retryAt && (
            <Button variant="secondary" onClick={cancelRetry}>
              <Ban size={14} /> Cancel retry
            </Button>
          )}
          {onRetry &&
            !log?.retryAt &&
            isTerminal &&
            (status === "failed" || status === "timeout" || status === "interrupted") && (
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
