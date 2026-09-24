import React from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Receipt,
  RotateCcw,
  Sparkles,
  Video,
  XCircle,
} from "lucide-react";
import {
  api,
  Company,
  Routine,
  Run,
  RunBrowserRecording,
  RunCheckResult,
  RunCheckResultList,
  RunChecksVerdict,
  RunEffect,
  RunEffectList,
  RunErrorKind,
  RunLog,
  RunOutcomeVerdict,
  RunStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { errorMessage } from "@/lib/errors";
import { LiveBrowserRecording } from "@/components/routines/LiveBrowserRecording";
import { RunExplanation, runExplanationLabel } from "@/components/routines/RunExplanation";
import { RunResumeButton } from "@/components/routines/RunResumeButton";
import { runNeedsAttention, runStatusHint, runStatusLabel } from "@/lib/runStatus";

/**
 * Shared rendering for Runs — one execution of a Routine. Lives here rather
 * than beside a page because the Routines list, the routine detail page, and
 * the live-tail modal all render the same status vocabulary, and a run that
 * looks `failed` in one place must not look `skipped` in another.
 */

const RUN_STATUS_STYLE: Record<RunStatus, string> = {
  reviewed:
    "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  running:
    "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
  completed:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  failed:
    "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  error:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30",
  skipped:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  timeout:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30",
  interrupted:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30",
};

/**
 * Errors are operational problems; Failed means intended work was not done.
 * Legacy timeout/interrupted rows use Error while their detail stays on hover.
 */
export function RunStatusChip({
  status,
  errorKind,
  size = "sm",
}: {
  status: RunStatus;
  errorKind?: RunErrorKind | null;
  size?: "xs" | "sm";
}) {
  return (
    <span
      title={runStatusHint(status, errorKind)}
      className={
        "inline-flex shrink-0 items-center gap-1 rounded border font-medium uppercase tracking-wide " +
        (size === "xs" ? "px-1.5 py-0.5 text-[10px] " : "px-2 py-0.5 text-xs ") +
        RUN_STATUS_STYLE[status]
      }
    >
      {status === "running" && <Loader2 size={10} className="animate-spin" />}
      {runStatusLabel(status)}
    </span>
  );
}

/** Separate from the transcript so an explicit incomplete-work report is easy to find. */
export function RunFailureNotice({ reason }: { reason?: string | null }) {
  if (!reason?.trim()) return null;
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm dark:border-rose-500/30 dark:bg-rose-500/10">
      <p className="font-medium text-rose-800 dark:text-rose-200">Why this Run failed</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300">
        {reason}
      </p>
    </div>
  );
}

export function RunContinuationNotice({
  continuationPending,
  continuationStopReason,
}: Pick<Run, "continuationPending" | "continuationStopReason">) {
  if (!continuationPending && !continuationStopReason?.trim()) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/60">
      <p className="font-medium text-slate-800 dark:text-slate-200">
        {continuationPending ? "Continuation scheduled" : "Automatic continuation stopped"}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">
        {continuationPending
          ? "The AI Employee will continue unfinished work from its saved progress. No setup is needed."
          : continuationStopReason}
      </p>
    </div>
  );
}

export function RunReviewNotice({ companySlug }: { companySlug: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
      This Run reviewed the situation. It did not carry out the proposed work.{" "}
      <Link
        to={`/c/${companySlug}/decisions`}
        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        Open Decision stack
      </Link>
    </div>
  );
}

const OUTCOME_STYLE: Record<RunOutcomeVerdict, string> = {
  achieved:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  unclear:
    "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/30",
  off_goal:
    "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  // Dashed, and amber rather than slate: `unclear` is a quiet result, this is
  // a gap. Nothing about this run was graded, and it must not read as one of
  // the three verdicts a grader can reach.
  unverified:
    "border-dashed bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/40",
};

const OUTCOME_LABEL: Record<RunOutcomeVerdict, string> = {
  achieved: "achieved",
  unclear: "unclear",
  off_goal: "off goal",
  unverified: "unverified",
};

/**
 * What the chip means on hover, when the grader left no note of its own.
 *
 * The pair that has to stay apart is `unclear` and `unverified`. `unclear` is
 * a judgement — a grader read the evidence and could not tell. `unverified` is
 * the absence of one: no grader ever reached a verdict. They used to be the
 * same value, which let an ungraded run bank the same credit as a graded one.
 */
const OUTCOME_HINT: Record<RunOutcomeVerdict, string> = {
  achieved: "A grader read the evidence and found the acceptance criteria met.",
  unclear: "A grader read the evidence and could not tell either way.",
  off_goal: "A grader read the evidence and found the acceptance criteria missed.",
  unverified: "Nobody graded this run. This is the absence of a verdict, not a verdict.",
};

/**
 * The second axis on a run: status records how it ended, the verdict says
 * whether the work met the Routine's acceptance criteria. Only rendered when a
 * verdict exists — routines without criteria stay exactly as before.
 */
export function RunOutcomeChip({
  verdict,
  note,
  size = "sm",
}: {
  verdict: RunOutcomeVerdict;
  note?: string | null;
  size?: "xs" | "sm";
}) {
  return (
    <span
      title={note ?? OUTCOME_HINT[verdict]}
      className={
        "inline-flex shrink-0 items-center gap-1 rounded border font-medium uppercase tracking-wide " +
        (size === "xs" ? "px-1.5 py-0.5 text-[10px] " : "px-2 py-0.5 text-xs ") +
        OUTCOME_STYLE[verdict]
      }
    >
      {OUTCOME_LABEL[verdict]}
    </span>
  );
}

const CHECKS_STYLE: Record<RunChecksVerdict, string> = {
  passed:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  failed:
    "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  not_run: "",
};

/**
 * The third axis: the outcome verdict is a model reading a transcript, this is
 * the server observing something the model cannot narrate — a command exited
 * 0, or the effect ledger really contains the write the run claims.
 *
 * `not_run` renders nothing on purpose. It means the Routine declares no
 * Checks, which is the common case; a chip saying so on every run would be a
 * permanent reminder of a feature nobody here uses, on the row where the
 * reader is trying to see what happened.
 */
export function RunChecksChip({
  verdict,
  size = "sm",
}: {
  verdict: RunChecksVerdict;
  size?: "xs" | "sm";
}) {
  if (verdict === "not_run") return null;
  return (
    <span
      title={
        verdict === "passed"
          ? "Every required Check on this Routine held."
          : "A required Check did not hold, so this run is not green however its transcript reads."
      }
      className={
        "inline-flex shrink-0 items-center gap-1 rounded border font-medium uppercase tracking-wide " +
        (size === "xs" ? "px-1.5 py-0.5 text-[10px] " : "px-2 py-0.5 text-xs ") +
        CHECKS_STYLE[verdict]
      }
    >
      {verdict === "passed" ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
      checks {verdict}
    </span>
  );
}

/** Compact token count — "12.4k", "1.2M" — for chips and table cells. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  // Round first, then pick the unit: 999,999 rounds to 1000.0k, which should
  // read as 1M rather than as a four-digit "k".
  const thousands = Math.round(n / 100) / 10;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(n / 100_000) / 10}M`;
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

/** Keep queued continuation controls current as well as Run and video state. */
export function runLogNeedsPolling(log: RunLog): boolean {
  return (
    log.status === "running" ||
    log.continuationPending === true ||
    // The outcome check runs after the transcript is final, so a completed run
    // on a routine with acceptance criteria lands its verdict a moment after
    // the status does. Keep polling until it arrives, or the chip would only
    // ever appear on a reload.
    (log.status === "completed" && log.awaitingOutcome === true) ||
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
  if (recording.status === "recording") return "Live";
  if (recording.status === "finalizing") return "Finalizing";
  if (recording.status === "failed") return "Failed";
  return "Ready";
}

/**
 * The recordings worth giving screen space to. A `failed` session saved no
 * video at all, and a panel whose only content is "there is no video here"
 * adds nothing beside a Run log that already says what happened.
 */
export function visibleBrowserRecordings(
  recordings: RunBrowserRecording[] | null | undefined,
): RunBrowserRecording[] {
  return (recordings ?? []).filter((recording) => recording.status !== "failed");
}

/**
 * Live and saved visual browser evidence for a Run. Browser-enabled work can delegate,
 * so the selector handles several independent BrowserSessions without making
 * the common one-recording case feel like an artifact manager.
 */
export function RunBrowserRecordingsPane({
  companyId,
  runId,
  recordings: allRecordings,
  className = "min-h-[360px] max-h-[60vh]",
}: {
  companyId: string;
  runId: string;
  recordings: RunBrowserRecording[];
  className?: string;
}) {
  // Filtered here as well as at the call sites, so a Run whose only browser
  // session failed renders nothing at all instead of an empty player.
  const recordings = React.useMemo(() => visibleBrowserRecordings(allRecordings), [allRecordings]);
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

      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-slate-950">
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
                </a>{" "}
                instead.
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
            className="absolute inset-0 h-full w-full bg-black object-contain"
          >
            <source src={recordingUrl} type={selected.mimeType ?? "video/mp4"} />
            Your browser cannot play this recording. Use Download instead.
          </video>
        ) : selected.status === "recording" ? (
          <LiveBrowserRecording key={recordingUrl} url={`${recordingUrl}/live`} />
        ) : selected.status === "finalizing" ? (
          <RecordingState
            icon={<Loader2 size={24} className="animate-spin" />}
            title="Finalizing browser recording…"
            body="Genosyn is preparing the video for playback."
          />
        ) : (
          // Defensive only: `failed` sessions never reach the pane, so this
          // catches a status this build doesn't know about yet.
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

/* ------------------------------------------------------------------------ *
 * Evidence — the two panels that are not the transcript
 *
 * The Run log is what the model said it did. These two are what the server
 * saw: the Checks it ran, and the writes it recorded. Keeping them next to the
 * transcript rather than on a page of their own is the point — the reader who
 * needs them is the reader deciding whether to believe the transcript.
 * ------------------------------------------------------------------------ */

function EvidenceSection({
  title,
  icon,
  meta,
  children,
  className = "",
}: {
  title: string;
  icon: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950 " +
        className
      }
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <span className="shrink-0 text-slate-400 dark:text-slate-500">{icon}</span>
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</span>
        {meta && <span className="text-[11px] text-slate-400 dark:text-slate-500">{meta}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function EvidenceLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-4 text-xs text-slate-400 dark:text-slate-500">
      <Loader2 size={13} className="animate-spin" /> {label}
    </div>
  );
}

/**
 * Every Check result on one Run, in the order they ran.
 *
 * Renders nothing when the Run produced none. That is not a missing empty
 * state: it means the Routine declares no Checks, which is most Routines, and
 * a panel explaining its own absence under every Run log would cost more
 * attention than it returns. The Checks verdict chip is hidden for the same
 * reason, so the two agree.
 */
export function RunChecksStrip({
  companyId,
  runId,
  /** Change this to re-read — a live Run lands its results at the very end. */
  reloadKey,
  className = "",
}: {
  companyId: string;
  runId: string;
  reloadKey?: string;
  className?: string;
}) {
  const [results, setResults] = React.useState<RunCheckResult[] | null>(null);
  const [coverage, setCoverage] = React.useState<RunCheckResultList | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get<RunCheckResultList>(`/api/companies/${companyId}/routines/runs/${runId}/checks`)
      .then((data) => {
        if (cancelled) return;
        setResults(data.results ?? []);
        setCoverage(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResults([]);
        setError(errorMessage(err, "Could not load this run's Checks"));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, runId, reloadKey]);

  if (error) return <FormError message={error} className={className} />;
  if (results === null) return null;
  if (results.length === 0)
    return (
      <EvidenceSection
        title="Checks"
        icon={<CheckCircle2 size={14} />}
        meta="No Check evidence"
        className={className}
      >
        <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
          {coverage?.runStatus === "running"
            ? "No Check results have been recorded yet."
            : "No Checks ran for this Run. Its status alone does not verify coverage, artifacts or safety requirements."}
          {coverage?.currentConfiguration?.enabled === 0
            ? " This Routine currently has no enabled Checks. A company admin can configure them at Routine → Settings → Checks."
            : " Current Routine settings may differ from those used for this Run."}
        </p>
      </EvidenceSection>
    );

  const rounds = new Set(results.map((r) => r.attempt)).size;

  return (
    <EvidenceSection
      title="Checks"
      icon={<CheckCircle2 size={14} />}
      meta={`${results.length} result${results.length === 1 ? "" : "s"}${rounds > 1 ? ` across ${rounds} rounds` : ""}`}
      className={className}
    >
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {results.map((result) => (
          <li key={result.id} className="flex items-start gap-2 px-3 py-2">
            <span className="mt-0.5 shrink-0">
              {result.passed ? (
                <CheckCircle2 size={14} className="text-emerald-600 dark:text-emerald-400" />
              ) : (
                <XCircle
                  size={14}
                  className={
                    result.required
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-amber-600 dark:text-amber-400"
                  }
                />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium text-slate-800 dark:text-slate-100">
                  {result.name}
                </span>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {result.required ? "required" : "advisory"}
                </span>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {result.kind}
                </span>
                {/* Which round this came from. A run that only went green on
                      the second try should say so — that is the difference
                      between a Routine that works and one that is nursed. */}
                <span className="text-[10px] text-slate-400 dark:text-slate-500">
                  {result.attempt === 0 ? "first pass" : `remediation round ${result.attempt}`}
                </span>
                {result.exitCode !== null && (
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">
                    exit {result.exitCode}
                  </span>
                )}
              </div>
              {result.detail && (
                <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {result.detail}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </EvidenceSection>
  );
}

/**
 * Everything one Run changed, as rows.
 *
 * The lead sentence is load-bearing, not decoration. Every other block on this
 * screen is the model's own account of its work, and a reader who does not
 * know where these rows came from will read them as more of the same — a list
 * the model wrote about itself. They are the opposite: the server wrote one at
 * each write seam while the Run held its token, which is what makes them
 * usable as evidence and what an `effect` Check asserts over.
 *
 * Rows rather than prose for the same reason. A paragraph summarizing "sent
 * three emails and updated the deal" is a narration again; five lines naming
 * the action, the thing, and the minute are a ledger.
 */
export function RunEffectsPane({
  companyId,
  runId,
  reloadKey,
  className = "",
}: {
  companyId: string;
  runId: string;
  reloadKey?: string;
  className?: string;
}) {
  const [data, setData] = React.useState<RunEffectList | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get<RunEffectList>(`/api/companies/${companyId}/routines/runs/${runId}/effects`)
      .then((next) => {
        if (cancelled) return;
        setData({ effects: next.effects ?? [], total: next.total ?? 0 });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err, "Could not load this run's effects"));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, runId, reloadKey]);

  const shown = data?.effects.length ?? 0;
  const hidden = Math.max(0, (data?.total ?? 0) - shown);

  return (
    <EvidenceSection
      title="Effects"
      icon={<Receipt size={14} />}
      meta={data ? `${data.total} recorded` : undefined}
      className={className}
    >
      <p className="border-b border-slate-100 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
        These rows were written by the server at each write seam this run passed through — they are
        not the model&apos;s account of what it did.
      </p>
      <FormError message={error} className="m-3" />
      {!error && data === null && <EvidenceLoading label="Loading effects…" />}
      {!error && data !== null && shown === 0 && (
        <p className="px-3 py-4 text-xs text-slate-400 dark:text-slate-500">
          This run changed nothing. Nothing it may have read, said, or decided appears here — only
          writes do.
        </p>
      )}
      {!error && data !== null && shown > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.effects.map((effect, index) => (
            <EffectRow key={`${effect.at}-${effect.action}-${index}`} effect={effect} />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
          and {hidden.toLocaleString()} more not shown
        </p>
      )}
    </EvidenceSection>
  );
}

function EffectRow({ effect }: { effect: RunEffect }) {
  const at = new Date(effect.at);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-[11px]">
      <span className="shrink-0 font-mono font-medium text-slate-700 dark:text-slate-200">
        {effect.action}
      </span>
      <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">
        {effect.targetLabel || effect.targetType}
      </span>
      <span
        className="shrink-0 tabular-nums text-slate-400 dark:text-slate-500"
        title={at.toLocaleString()}
      >
        {at.toLocaleTimeString()}
      </span>
    </li>
  );
}

/**
 * Live tail for a run that was just kicked off. Polls `/runs/:runId/log` until
 * the server reports a terminal status and every browser recording has left
 * its transitional state. That endpoint serves the in-memory buffer while the
 * child is alive and the persisted log once it finalizes, so one poll drives
 * the whole modal — no separate status or recording probe.
 */
type RunLiveModalProps = {
  company: Company;
  routine: Pick<Routine, "id" | "name">;
  run: Run;
  onClose: () => void;
  onRetry?: () => void;
  onResumed?: (run: Run) => void | Promise<void>;
  initialView?: "log" | "explanation";
};

export function RunLiveModal(props: RunLiveModalProps) {
  const [resumed, setResumed] = React.useState<{ sourceRunId: string; run: Run } | null>(null);
  const run = resumed?.sourceRunId === props.run.id ? resumed.run : props.run;
  return (
    <RunLiveModalContent
      {...props}
      key={run.id}
      run={run}
      initialView={run.id === props.run.id ? props.initialView : "log"}
      onResumed={async (next) => {
        setResumed({ sourceRunId: props.run.id, run: next });
        await props.onResumed?.(next);
      }}
    />
  );
}

function RunLiveModalContent({
  company,
  routine,
  run: initialRun,
  onClose,
  onRetry,
  onResumed,
  initialView = "log",
}: RunLiveModalProps & { onResumed: (run: Run) => void | Promise<void> }) {
  const [log, setLog] = React.useState<RunLog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const preRef = React.useRef<HTMLPreElement>(null);
  const userScrolledRef = React.useRef(false);
  const [view, setView] = React.useState(initialView);
  const [explanationOpened, setExplanationOpened] = React.useState(initialView === "explanation");

  const tabsId = React.useId();
  const status: RunStatus = log?.status ?? initialRun.status;
  const isTerminal = status !== "running";
  const recordings = visibleBrowserRecordings(log?.browserRecordings);
  // Both evidence panels are one-shot reads, so they need a reason to look
  // again. Checks land as the loop returns and the ledger keeps growing until
  // it does, which makes the terminal status — and the checks verdict written
  // just before it — the only re-read this modal needs.
  const evidenceKey = `${status}:${log?.checksVerdict ?? ""}`;

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
    if (!el || view !== "log" || userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [log?.content, view]);

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
      setLog((cur) => (cur ? { ...cur, retryAt: null, continuationPending: false } : cur));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const tokens =
    (log?.tokensIn ?? initialRun.tokensIn ?? 0) + (log?.tokensOut ?? initialRun.tokensOut ?? 0);
  const startedAt = log?.startedAt ?? initialRun.startedAt;
  const finishedAt = log ? log.finishedAt : initialRun.finishedAt;
  const exitCode = log ? log.exitCode : initialRun.exitCode;
  const needsAttention = runNeedsAttention(status);
  const metrics = [
    {
      label: "Duration",
      value: isTerminal ? formatDuration(startedAt, finishedAt ?? null) : "In progress",
    },
    { label: "Tokens", value: tokens > 0 ? formatTokens(tokens) : "—" },
    { label: "Attempt", value: String(log?.attempt ?? initialRun.attempt ?? 1) },
    {
      label: "Exit code",
      value: exitCode === null || exitCode === undefined ? "—" : String(exitCode),
    },
  ];

  function selectView(next: "log" | "explanation") {
    if (next === "explanation") setExplanationOpened(true);
    setView(next);
  }

  function navigateTabs(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(
      event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const current = tabs.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Run: ${routine.name}`}
      size="xl"
      padded={false}
      bodyMode="fill"
      panelClassName="h-[min(720px,calc(100dvh-2rem))] sm:max-w-4xl"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col [@media(max-height:500px)]:overflow-y-auto">
        <div className="shrink-0 border-b border-slate-200/80 bg-slate-50/60 px-4 py-3 sm:px-5 dark:border-slate-800 dark:bg-slate-950/30">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <RunStatusChip status={status} errorKind={log?.errorKind ?? initialRun.errorKind} />
              {status !== "reviewed" && log?.outcomeVerdict && (
                <RunOutcomeChip verdict={log.outcomeVerdict} note={log.outcomeNote} />
              )}
              {status !== "reviewed" && log?.checksVerdict && (
                <RunChecksChip verdict={log.checksVerdict} />
              )}
              {log?.live && (
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500" /> Live
                </span>
              )}
              {!isTerminal && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Continues if you close this window
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RunResumeButton
                company={company}
                routineName={routine.name}
                run={{
                  id: initialRun.id,
                  status,
                  errorKind: log?.errorKind ?? initialRun.errorKind,
                  hasUnfinishedWork: log?.hasUnfinishedWork ?? initialRun.hasUnfinishedWork,
                  retryAt: log ? log.retryAt : initialRun.retryAt,
                  continuationPending: log?.continuationPending ?? initialRun.continuationPending,
                }}
                onResumed={onResumed}
              />
              {log?.retryAt ? (
                <Button variant="secondary" size="sm" onClick={cancelRetry}>
                  <Ban size={13} />{" "}
                  {log.continuationPending ? "Cancel continuation" : "Cancel retry"}
                </Button>
              ) : onRetry && isTerminal && needsAttention ? (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                  <RotateCcw size={13} /> Retry
                </Button>
              ) : null}
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-4 divide-x divide-slate-200 dark:divide-slate-700">
            {metrics.map(({ label, value }) => (
              <div key={label} className="min-w-0 px-2 first:pl-0 last:pr-0 sm:px-5">
                <dt className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {label}
                </dt>
                <dd className="mt-1 text-xs font-medium tabular-nums text-slate-800 sm:text-sm dark:text-slate-100">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {((log?.checkRemediations ?? 0) > 0 ||
            (log?.continuationCount ?? initialRun.continuationCount ?? 0) > 0 ||
            log?.retryAt) && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              {(log?.checkRemediations ?? 0) > 0 && (
                <span>
                  {log?.checkRemediations} Check remediation
                  {log?.checkRemediations === 1 ? "" : "s"}
                </span>
              )}
              {(log?.continuationCount ?? initialRun.continuationCount ?? 0) > 0 && (
                <span>Continuation {log?.continuationCount ?? initialRun.continuationCount}</span>
              )}
              {log?.retryAt && (
                <span>
                  {log.continuationPending ? "Continuation scheduled" : "Retry scheduled"}{" "}
                  {timeUntil(log.retryAt)}
                </span>
              )}
            </div>
          )}
        </div>
        {needsAttention && (
          <div
            role="tablist"
            aria-label="Run details"
            className="flex shrink-0 gap-5 border-b border-slate-200 px-4 sm:px-5 dark:border-slate-800"
          >
            {(
              [
                { id: "log", label: "Run log", icon: FileText },
                { id: "explanation", label: runExplanationLabel(status), icon: Sparkles },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${tabsId}-${tab.id}`}
                aria-controls={`${tabsId}-${tab.id}-panel`}
                aria-selected={view === tab.id}
                tabIndex={view === tab.id ? 0 : -1}
                onClick={() => selectView(tab.id)}
                onKeyDown={navigateTabs}
                className={
                  "-mb-px inline-flex items-center gap-2 border-b-2 py-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/40 sm:text-sm " +
                  (view === tab.id
                    ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-300"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200")
                }
              >
                <tab.icon size={14} aria-hidden="true" /> {tab.label}
              </button>
            ))}
          </div>
        )}
        {error && <FormError message={error} className="mx-4 mt-3 sm:mx-5" />}
        {explanationOpened && (
          <div
            hidden={view !== "explanation"}
            role="tabpanel"
            id={`${tabsId}-explanation-panel`}
            aria-labelledby={`${tabsId}-explanation`}
            className="min-h-0 flex-1 [@media(max-height:500px)]:min-h-[380px] [@media(max-height:500px)]:shrink-0"
          >
            <RunExplanation
              key={`${company.id}:${initialRun.id}`}
              companyId={company.id}
              runId={initialRun.id}
              active={view === "explanation"}
            />
          </div>
        )}
        <div
          hidden={view !== "log"}
          role={needsAttention ? "tabpanel" : undefined}
          id={`${tabsId}-log-panel`}
          aria-labelledby={needsAttention ? `${tabsId}-log` : undefined}
          tabIndex={view === "log" ? 0 : -1}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 sm:p-5 [@media(max-height:500px)]:min-h-[300px] [@media(max-height:500px)]:shrink-0"
        >
          <RunContinuationNotice
            continuationPending={log?.continuationPending ?? initialRun.continuationPending}
            continuationStopReason={
              log?.continuationStopReason ?? initialRun.continuationStopReason
            }
          />
          {status === "reviewed" && <RunReviewNotice companySlug={company.slug} />}
          <RunFailureNotice reason={log?.failureReason ?? initialRun.failureReason} />
          {log?.diagnostics?.failure && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-xs dark:border-orange-500/30 dark:bg-orange-500/10">
              <p className="font-medium text-orange-900 dark:text-orange-200">
                Failure details · {log.diagnostics.failure.category} ·{" "}
                {log.diagnostics.failure.phase}
              </p>
              {log.diagnostics.failure.step && (
                <p className="mt-1 break-words">Step: {log.diagnostics.failure.step.tool}</p>
              )}
              <p className="mt-1 whitespace-pre-wrap break-words">
                {log.diagnostics.failure.message}
              </p>
              {log.diagnostics.failure.exception && (
                <p className="mt-1">Exception: {log.diagnostics.failure.exception}</p>
              )}
              {log.diagnostics.toolErrors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer">Recent tool errors</summary>
                  <ul className="mt-1 space-y-1">
                    {log.diagnostics.toolErrors.map((error, index) => (
                      <li key={index} className="break-words">
                        {error.step?.tool ?? "Tool"}: {error.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {log?.outcomeNote && (
            <p className="text-xs text-slate-500 dark:text-slate-400">{log.outcomeNote}</p>
          )}
          <div
            className={
              "grid min-h-[240px] min-w-0 gap-3 " + (recordings.length > 0 ? "md:grid-cols-2" : "")
            }
          >
            <RunLogPane
              log={log}
              loading={log === null && !error}
              preRef={preRef}
              onScroll={handleScroll}
              placeholder={log === null ? "Starting…" : "Waiting for output…"}
              className="max-h-[45vh] min-h-[240px]"
            />
            {recordings.length > 0 && (
              <RunBrowserRecordingsPane
                companyId={company.id}
                runId={initialRun.id}
                recordings={recordings}
                className="min-h-[240px] max-h-[45vh]"
              />
            )}
          </div>
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <RunChecksStrip
              companyId={company.id}
              runId={initialRun.id}
              reloadKey={evidenceKey}
              className="max-h-64"
            />
            <RunEffectsPane
              companyId={company.id}
              runId={initialRun.id}
              reloadKey={evidenceKey}
              className="max-h-64"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
