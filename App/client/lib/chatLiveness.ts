import {
  describeChatToolDraft,
  formatElapsed,
  MODEL_UNAVAILABLE_WAIT_LABEL,
  type ChatActivityEvent,
  type ModelPulse,
} from "../../shared/chatActivity";
import { buildActivitySteps, type ActivityStep, type ToolStep } from "./chatActivity";
import { formatTokensCompact } from "./chatContextUsage";

/**
 * What a running chat turn is doing right now, in words a Member can act on.
 *
 * "Is it stuck?" is the question this exists to answer, and it answers from
 * evidence. The AI Model's own stream says what the model is doing between the
 * steps (`ModelPulse`): waiting to start answering, thinking, writing the reply,
 * writing a tool call's arguments. So a turn reads as working for as long as the
 * model is sending anything, however long it thinks, and only an AI Model that
 * has actually gone silent is called silent — with how long, and what it was
 * doing. A turn can also be waiting on something named (another reply in the
 * thread, a retry after a model error), or running a tool.
 *
 * A reader attached to another server has no pulses, only the steps. It says so
 * rather than call a turn it cannot see quiet.
 *
 * Every time is on the server's clock (`LiveTurnState.clockOffsetMs`), so a
 * browser whose clock is off by minutes still counts the same seconds.
 */

/** Past this with no pulse and no step, a reader that has only the steps says so. */
export const QUIET_AFTER_MS = 45_000;
/**
 * Silence on a stream that has started. Providers send keep-alives while they
 * work, and OpenAI's reasoning can still pause for a good while between events,
 * so this has to be long enough to mean something.
 */
export const STREAM_SILENT_AFTER_MS = 120_000;
/** A request nothing has come back for: a long prompt on a slow model can take this long. */
export const FIRST_ANSWER_SILENT_AFTER_MS = 180_000;
/** Data within this long reads as "receiving now". */
export const RECEIVING_WINDOW_MS = 4_000;
/** A wait this long gets a line saying what the time is usually spent on. */
export const EXPLAIN_WAIT_AFTER_MS = 20_000;
/** A status this close to the turn's start would show a second clock reading the same. */
const SAME_CLOCK_MS = 2_000;
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
  /** Nothing has been asked of the AI Model yet: the turn is getting ready. */
  | { kind: "preparing"; since: number; label: string | null }
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
  /** The request is out, and nothing has come back yet. */
  | { kind: "asking"; since: number }
  /** `silentMs` is how long since the model last sent anything; 0 when that is unknown. */
  | { kind: "thinking"; since: number; headline: string | null; silentMs: number }
  /** The AI Model is writing the arguments of a tool call. */
  | { kind: "drafting"; since: number; tool: string | null; chars: number }
  | { kind: "writing"; since: number; timed: boolean }
  | { kind: "compacting"; since: number }
  /** One request to the AI Model has ended and the runtime has not shown what is next. */
  | { kind: "between"; since: number }
  /** The AI Model's stream has gone silent; `was` is what it was doing. */
  | {
      kind: "silent";
      since: number;
      silentMs: number;
      was: "waiting" | "thinking" | "writing" | "tool_input" | "compacting";
    }
  /** No pulses reach this reader: only that no step has landed for a while. */
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
  /** What the AI Model is doing, when this reader can see its stream. */
  pulse?: ModelPulse | null;
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

  const fromStream = input.pulse ? phaseFromPulse(input.pulse, steps, now) : null;
  if (fromStream) return fromStream;

  if (input.lastTextAt !== null && now - input.lastTextAt <= WRITING_WINDOW_MS) {
    return { kind: "writing", since: input.lastTextAt, timed: false };
  }

  const started = input.events.some((event) => event.kind === "turn_started");
  const lastActivity = Math.max(
    lastEventAt(input.events) ?? -Infinity,
    input.lastTextAt ?? -Infinity,
    timeOf(input.pulse?.since) ?? -Infinity,
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
  if (input.pulse?.state === "finished") return { kind: "between", since: lastActivity };
  const thought = latestThinking(steps);
  return {
    kind: "thinking",
    since: lastActivity,
    headline: thought ? headlineOf(thought) : null,
    silentMs: 0,
  };
}

/** What the AI Model's stream says, or null once its request has ended. */
function phaseFromPulse(pulse: ModelPulse, steps: ActivityStep[], now: number): LivePhase | null {
  const since = timeOf(pulse.since) ?? now;
  const lastHeard = timeOf(pulse.lastDataAt) ?? timeOf(pulse.sentAt) ?? since;
  const silentMs = Math.max(0, now - lastHeard);
  const silent = (was: Extract<LivePhase, { kind: "silent" }>["was"]): LivePhase => ({
    kind: "silent",
    since: lastHeard,
    silentMs,
    was,
  });
  switch (pulse.state) {
    case "preparing":
      return { kind: "preparing", since, label: pulse.label };
    case "waiting":
      return silentMs > FIRST_ANSWER_SILENT_AFTER_MS ? silent("waiting") : { kind: "asking", since };
    case "thinking": {
      if (silentMs > STREAM_SILENT_AFTER_MS) return silent("thinking");
      const thought = latestThinking(steps);
      return {
        kind: "thinking",
        since,
        headline: thought ? headlineOf(thought) : null,
        silentMs,
      };
    }
    case "tool_input":
      return silentMs > STREAM_SILENT_AFTER_MS
        ? silent("tool_input")
        : { kind: "drafting", since, tool: pulse.tool, chars: pulse.chars };
    case "writing":
      return silentMs > STREAM_SILENT_AFTER_MS
        ? silent("writing")
        : { kind: "writing", since, timed: true };
    case "compacting":
      return silentMs > STREAM_SILENT_AFTER_MS ? silent("compacting") : { kind: "compacting", since };
    default:
      return null;
  }
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
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
  /** The status line; may count seconds ("No data from the AI Model for 2m 5s"). */
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
  return { ...words, announce: announcementFor(phase, words.title) };
}

function announcementFor(phase: LivePhase, title: string): string {
  switch (phase.kind) {
    case "silent":
      return "The AI Model has gone silent";
    case "quiet":
      return phase.before === "starting" ? "Not started yet" : "Working";
    case "waiting":
      return phase.cause === "model_retry" ? "Retrying the AI Model" : title;
    case "drafting":
      return "Preparing the next step";
    case "thinking":
      return "Thinking";
    default:
      return title;
  }
}

function phaseWords(
  phase: LivePhase,
  employeeName: string,
  now: number,
): Omit<PhaseWords, "announce"> {
  switch (phase.kind) {
    case "starting":
      return { title: "Starting", detail: null, tone: "working" };
    case "preparing":
      return { title: "Getting ready", detail: phase.label, tone: "working" };
    case "asking":
      return {
        title: "Waiting for the AI Model to start answering",
        detail:
          now - phase.since > EXPLAIN_WAIT_AFTER_MS
            ? "It has the request. Long conversations and higher thinking levels take longer to start."
            : null,
        tone: "working",
      };
    case "writing":
      return { title: "Writing the reply", detail: null, tone: "working" };
    case "between":
      return { title: "Working", detail: null, tone: "working" };
    case "thinking":
      return {
        title: phase.headline ? `Thinking: ${phase.headline}` : "Thinking",
        detail:
          phase.silentMs > EXPLAIN_WAIT_AFTER_MS
            ? "AI Models can go quiet while they think hard. It can still pick up from here."
            : null,
        tone: "working",
      };
    case "drafting":
      return {
        title: `Preparing: ${phase.tool ? describeChatToolDraft(phase.tool) : "the next step"}`,
        detail: draftDetail(phase, now),
        tone: "working",
      };
    case "compacting":
      return {
        title: "Compacting the conversation",
        detail: "Older parts are being summarized to fit the AI Model's context window.",
        tone: "working",
      };
    case "silent":
      return {
        title: `No data from the AI Model for ${formatElapsed(phase.silentMs)}`,
        detail: `${silentContext(phase.was)} You can keep waiting or stop.`,
        tone: "warning",
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
      return phase.before === "starting"
        ? {
            title: "Not started yet",
            detail: `${employeeName} has not started on this yet. It may be waiting for capacity — you can keep waiting or stop.`,
            tone: "warning",
          }
        : {
            title: "Working",
            detail: `No step has finished for ${formatElapsed(phase.quietMs)}. The AI Model may well still be thinking, and this view updates when a step lands. You can keep waiting or stop.`,
            tone: "waiting",
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

function draftDetail(phase: Extract<LivePhase, { kind: "drafting" }>, now: number): string | null {
  const written = phase.chars > 0 ? `${formatSize(phase.chars)} written so far.` : "";
  const why =
    now - phase.since > EXPLAIN_WAIT_AFTER_MS
      ? "Long arguments, such as a whole document, take a while to write."
      : "";
  return [written, why].filter(Boolean).join(" ") || null;
}

function silentContext(was: Extract<LivePhase, { kind: "silent" }>["was"]): string {
  switch (was) {
    case "waiting":
      return "It has the request and has not started answering. A long prompt on a slow AI Model can take this long.";
    case "thinking":
      return "It was thinking when it went silent, and AI Models can pause on long work.";
    case "tool_input":
      return "It was writing the next step's arguments when it went silent.";
    case "writing":
      return "It was writing the reply when it went silent.";
    case "compacting":
      return "It was summarizing older parts of the conversation when it went silent.";
  }
}

/** "812 characters", "4.2 KB", "1.3 MB": how much a tool call's arguments have grown. */
export function formatSize(chars: number): string {
  if (chars < 1_000) return `${chars} ${chars === 1 ? "character" : "characters"}`;
  if (chars < 1_000_000) return `${(chars / 1_000).toFixed(1)} KB`;
  return `${(chars / 1_000_000).toFixed(1)} MB`;
}

/**
 * The running clock beside a status line, when this status has one of its own.
 * Beside the turn's own clock it says nothing until the two have parted.
 */
export function phaseClockSince(phase: LivePhase, turnStartedAt: number): number | null {
  const since = statusClockSince(phase);
  return since !== null && since - turnStartedAt >= SAME_CLOCK_MS ? since : null;
}

function statusClockSince(phase: LivePhase): number | null {
  switch (phase.kind) {
    case "waiting":
    case "tool":
    case "thinking":
    case "asking":
    case "preparing":
    case "drafting":
    case "compacting":
      return phase.since;
    case "writing":
      return phase.timed ? phase.since : null;
    default:
      return null;
  }
}

export type PulseSignal = { tone: "live" | "idle"; text: string };

/**
 * The evidence under a status line: whether anything is arriving from the AI
 * Model right now, and when something last did. It is what lets a Member tell
 * a long thought from a stuck one at a glance.
 */
export function describePulseSignal(pulse: ModelPulse | null, now: number): PulseSignal | null {
  if (!pulse) return null;
  if (pulse.state === "waiting") {
    const sentAt = timeOf(pulse.sentAt);
    return sentAt === null
      ? null
      : { tone: "idle", text: `Sent ${formatElapsed(Math.max(0, now - sentAt))} ago` };
  }
  if (pulse.state === "preparing" || pulse.state === "finished") return null;
  const lastData = timeOf(pulse.lastDataAt);
  if (lastData === null) return null;
  const silentMs = Math.max(0, now - lastData);
  return silentMs <= RECEIVING_WINDOW_MS
    ? { tone: "live", text: "Receiving now" }
    : { tone: "idle", text: `Last data ${formatElapsed(silentMs)} ago` };
}

/** The AI Model, which of its requests this is, and how much it has written this turn. */
export function describePulseFacts(pulse: ModelPulse | null): string[] {
  if (!pulse) return [];
  return [
    pulse.model ?? "",
    pulse.request > 1 ? `AI Model call ${pulse.request}` : "",
    pulse.outputTokens > 0 ? `~${formatTokensCompact(pulse.outputTokens)} tokens` : "",
  ].filter(Boolean);
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
    case "model_unavailable":
      // The server's words lead, as for any wait it names; the chat adds that
      // nothing needs resending and how to call it off.
      return {
        title: phase.label || MODEL_UNAVAILABLE_WAIT_LABEL,
        detail: `Nothing to resend: ${employeeName} answers it as soon as the AI Model answers again. Stop it to cancel.`,
        tone: "warning",
      };
    case "model_resuming":
      return {
        title: "Starting again now the AI Model is back",
        detail:
          "The replies that waited for it start one at a time, so they do not all land on it at once. This one starts shortly.",
        tone: "waiting",
      };
    default:
      return { title: phase.label || "Waiting", detail: null, tone: "waiting" };
  }
}

/** Time since `since`, as the running clock beside a status line. */
export function elapsedSince(since: number, now: number): string {
  return formatElapsed(Math.max(0, now - since));
}
