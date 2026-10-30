import { formatElapsed, type ChatActivityEvent } from "../../shared/chatActivity";
import { buildActivitySteps, type ActivityStep, type ToolStep } from "./chatActivity";

/**
 * What a running chat turn is doing right now, in words a Member can act on.
 *
 * "Is it stuck?" is the question the chat used to leave open. The answer has
 * three honest shapes and they look nothing alike: the employee is working (a
 * tool is running, the reply is being written), the turn is waiting on
 * something named (the AI Model, another reply in the thread, a retry after a
 * model error), or nothing at all has happened for a while. The last is said
 * plainly — "No activity for 52s" — rather than dressed up as progress.
 *
 * Every time is on the server's clock (`LiveTurnState.clockOffsetMs`), so a
 * browser whose clock is off by minutes still counts the same seconds.
 */

/** Waiting on the AI Model this long with no event at all reads as quiet. */
export const QUIET_AFTER_MS = 45_000;
/** A tool running this long gets a "taking a while" note — some legitimately do. */
export const SLOW_TOOL_AFTER_MS = 120_000;
/** Text that arrived this recently means the reply is being written. */
export const WRITING_WINDOW_MS = 2_500;
/** Accepted but not started for this long reads as quiet too. */
export const QUIET_START_AFTER_MS = 20_000;
/** No frame at all for this long: the connection, not the turn, is the problem. */
export const STALE_CONNECTION_AFTER_MS = 35_000;

export type LivePhase =
  | { kind: "starting"; since: number }
  | {
      kind: "waiting";
      cause: string;
      label: string;
      since: number;
      until: number | null;
      reason: string | null;
      attempt: number | null;
      maxAttempts: number | null;
    }
  | { kind: "tool"; step: ToolStep; running: number; since: number; slow: boolean }
  | { kind: "thinking"; since: number; headline: string | null }
  | { kind: "writing"; since: number }
  | { kind: "quiet"; since: number; quietMs: number; before: "starting" | "thinking" }
  | { kind: "stopping"; since: number }
  | { kind: "reconnecting"; since: number };

export type LivePhaseInput = {
  events: ChatActivityEvent[];
  /** When the turn was accepted. */
  startedAt: number;
  now: number;
  lastTextAt: number | null;
  lastSignalAt: number | null;
  /** How this browser follows the turn; `reconnecting` while it has lost it. */
  connection: "streaming" | "polling" | "reconnecting" | null;
  /** This browser asked the turn to stop and it has not finished yet. */
  stopping?: boolean;
  /** Part of the reply is already on screen, so the turn has certainly started. */
  hasReplyText?: boolean;
};

export function deriveLivePhase(input: LivePhaseInput): LivePhase {
  const { now } = input;
  if (input.connection === "reconnecting") {
    return { kind: "reconnecting", since: input.lastSignalAt ?? now };
  }
  if (
    input.connection === "streaming" &&
    input.lastSignalAt !== null &&
    now - input.lastSignalAt > STALE_CONNECTION_AFTER_MS
  ) {
    return { kind: "reconnecting", since: input.lastSignalAt };
  }
  if (input.stopping) return { kind: "stopping", since: now };

  const steps = buildActivitySteps(input.events);
  if (steps.some((step) => step.kind === "note" && step.code === "stopped")) {
    return { kind: "stopping", since: lastEventAt(input.events) ?? now };
  }

  const wait = openWait(steps, now);
  if (wait) {
    return {
      kind: "waiting",
      cause: wait.cause,
      label: wait.label,
      since: wait.startedAt,
      until: wait.until,
      reason: wait.reason,
      attempt: wait.attempt,
      maxAttempts: wait.maxAttempts,
    };
  }

  const running = steps.filter(
    (step): step is ToolStep => step.kind === "tool" && step.status === "running",
  );
  if (running.length > 0) {
    const newest = running[running.length - 1];
    return {
      kind: "tool",
      step: newest,
      running: running.length,
      since: newest.startedAt,
      slow: now - newest.startedAt > SLOW_TOOL_AFTER_MS,
    };
  }

  if (input.lastTextAt !== null && now - input.lastTextAt <= WRITING_WINDOW_MS) {
    return { kind: "writing", since: input.lastTextAt };
  }

  const started = input.events.some((event) => event.kind === "turn_started");
  const lastActivity = Math.max(
    lastEventAt(input.events) ?? -Infinity,
    input.lastTextAt ?? -Infinity,
    input.startedAt,
  );
  if (!started && input.events.length === 0 && input.lastTextAt === null && !input.hasReplyText) {
    const quietMs = now - input.startedAt;
    if (quietMs > QUIET_START_AFTER_MS) {
      return { kind: "quiet", since: input.startedAt, quietMs, before: "starting" };
    }
    return { kind: "starting", since: input.startedAt };
  }
  const quietMs = now - lastActivity;
  if (quietMs > QUIET_AFTER_MS) {
    return { kind: "quiet", since: lastActivity, quietMs, before: "thinking" };
  }
  const thought = latestThinking(steps);
  return { kind: "thinking", since: lastActivity, headline: thought ? headlineOf(thought) : null };
}

function openWait(steps: ActivityStep[], now: number) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.kind !== "wait") continue;
    if (step.endedAt !== null) return null;
    // A retry's backoff ends on its own; after it the model is thinking again.
    if (step.until !== null && step.until <= now) return null;
    return step;
  }
  return null;
}

function latestThinking(steps: ActivityStep[]) {
  const last = steps.at(-1);
  return last && last.kind === "thinking" ? last : null;
}

/**
 * The line a reasoning summary leads with: OpenAI's summaries open each
 * section with a bold title ("**Checking the ledger**"); otherwise its first
 * sentence.
 */
export function headlineOf(step: { text: string }): string | null {
  const text = step.text.trim();
  if (!text) return null;
  const titles = [...text.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  const title = titles.at(-1)?.[1]?.trim();
  if (title) return title;
  const line = text.split("\n").find((candidate) => candidate.trim()) ?? "";
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  const clean = sentence.replace(/[*_`#>]/g, "").trim();
  return clean ? (clean.length > 90 ? `${clean.slice(0, 89)}…` : clean) : null;
}

function lastEventAt(events: ChatActivityEvent[]): number | null {
  const last = events.at(-1);
  if (!last) return null;
  const at = Date.parse(last.at);
  return Number.isFinite(at) ? at : null;
}

export type PhaseWords = {
  /** The status line; may count seconds ("No activity for 52s"). */
  title: string;
  /**
   * The same status without any running count, for a live region: a screen
   * reader should hear the state change, not a number every second.
   */
  announce: string;
  /** A secondary line, when one helps. */
  detail: string | null;
  tone: "working" | "waiting" | "warning";
};

/** The words for a phase. `now` only feeds countdowns; the elapsed clock is drawn apart. */
export function describeLivePhase(phase: LivePhase, employeeName: string, now: number): PhaseWords {
  const words = phaseWords(phase, employeeName, now);
  const announce =
    phase.kind === "quiet"
      ? "No activity for a while"
      : phase.kind === "waiting" && phase.cause === "model_retry"
        ? "Retrying the AI Model"
        : words.title;
  return { ...words, announce };
}

function phaseWords(
  phase: LivePhase,
  employeeName: string,
  now: number,
): Omit<PhaseWords, "announce"> {
  switch (phase.kind) {
    case "starting":
      return { title: "Starting", detail: null, tone: "working" };
    case "writing":
      return { title: "Writing the reply", detail: null, tone: "working" };
    case "thinking":
      return {
        title: phase.headline ? `Thinking: ${phase.headline}` : "Thinking",
        detail: null,
        tone: "working",
      };
    case "tool": {
      const others = phase.running > 1 ? ` (+${phase.running - 1} more)` : "";
      return {
        title: `${phase.step.label}${others}`,
        detail: phase.slow
          ? "This step is taking a while. Some steps do — you can keep waiting or stop."
          : null,
        tone: "working",
      };
    }
    case "waiting":
      return describeWait(phase, employeeName, now);
    case "quiet":
      return {
        title: `No activity for ${formatElapsed(phase.quietMs)}`,
        detail:
          phase.before === "starting"
            ? `${employeeName} has not started on this yet. It may be waiting for capacity — you can keep waiting or stop.`
            : "The AI Model has not responded yet. Long conversations can take a while — you can keep waiting or stop.",
        tone: "warning",
      };
    case "stopping":
      return {
        title: "Stopping",
        detail: "The current step finishes first; what was written so far is kept.",
        tone: "waiting",
      };
    case "reconnecting":
      return {
        title: "Reconnecting to live updates",
        detail: `${employeeName} keeps working on the server meanwhile.`,
        tone: "warning",
      };
  }
}

function describeWait(
  phase: Extract<LivePhase, { kind: "waiting" }>,
  employeeName: string,
  now: number,
): Omit<PhaseWords, "announce"> {
  switch (phase.cause) {
    case "thread_busy":
      return {
        title: "Waiting for the previous reply",
        detail: `${employeeName} answers one message at a time in each conversation; this one starts when the previous reply finishes.`,
        tone: "waiting",
      };
    case "model_lock":
      return {
        title: "Waiting for the AI Model",
        detail:
          "This AI Model answers one turn at a time, across every AI Employee that uses it. This turn starts when the one ahead of it finishes.",
        tone: "waiting",
      };
    case "model_retry": {
      const seconds =
        phase.until !== null ? Math.max(0, Math.ceil((phase.until - now) / 1000)) : null;
      const attempt =
        phase.attempt !== null
          ? ` · attempt ${phase.attempt}${phase.maxAttempts !== null ? ` of ${phase.maxAttempts}` : ""}`
          : "";
      return {
        title:
          seconds !== null && seconds > 0
            ? `Retrying the AI Model in ${seconds}s`
            : "Retrying the AI Model",
        detail: `The AI Model's service failed${phase.reason ? ` (${phase.reason})` : ""}${attempt}.`,
        tone: "warning",
      };
    }
    case "model_outage":
      return {
        title: "Waiting for the AI Model's server",
        detail: "It stopped answering. The turn continues when it answers again.",
        tone: "warning",
      };
    default:
      return { title: phase.label || "Waiting", detail: null, tone: "waiting" };
  }
}

/** Time since `since`, as the running clock beside a status line. */
export function elapsedSince(since: number, now: number): string {
  return formatElapsed(Math.max(0, now - since));
}
