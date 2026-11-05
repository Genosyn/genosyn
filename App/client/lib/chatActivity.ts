import {
  describeChatToolCall,
  type ChatActivityEvent,
  type ChatToolFamily,
  type ModelCallDetail,
  type ModelPulse,
} from "../../shared/chatActivity";
import { withheldReason, type ActivityWithheld } from "../../shared/turnActivityAccess";

/**
 * A chat turn's activity in the browser: the events a turn recorded, folded
 * into the steps the chat draws.
 *
 * Events arrive from two places that can overlap — the stream of the request
 * that sent the message, and the follow stream a reload or a second tab opens
 * — and a reconnect can replay what was already seen. So the state is the
 * set of events by ordinal, merged idempotently, and every view is derived
 * from it: a step list that pairs each tool result with its call by `callId`
 * whichever arrived first, tolerates a result whose call was never seen, and
 * closes whatever was still open when the turn ended.
 *
 * Pure on purpose — `chatActivity.test.ts` drives it with recorded sequences.
 */

/** The live side of one in-flight turn, as the browser follows it. */
export type LiveTurnState = {
  /** The assistant reply this turn will become. */
  turnId: string | null;
  /** When the turn was accepted, on the server's clock (ms). */
  startedAt: number | null;
  /** Server clock minus this browser's, measured from the server's frames. */
  clockOffsetMs: number;
  /** When the last frame of any kind arrived, server clock (ms). */
  lastSignalAt: number | null;
  /** When the last piece of reply text arrived, server clock (ms). */
  lastTextAt: number | null;
  /** Recorded events, ascending by ordinal, without duplicates. */
  events: ChatActivityEvent[];
  /** The highest ordinal held; a follow stream resumes after it. */
  lastOrdinal: number;
  /**
   * What the AI Model is doing as of its latest reading. Null until one arrives,
   * and for good when the turn runs on a server this reader is not attached to.
   */
  pulse: ModelPulse | null;
  /** The end of what each running command has printed, by its call. Never stored. */
  toolOutputs: Record<string, string>;
};

export const EMPTY_LIVE_TURN: LiveTurnState = Object.freeze({
  turnId: null,
  startedAt: null,
  clockOffsetMs: 0,
  lastSignalAt: null,
  lastTextAt: null,
  events: [],
  lastOrdinal: 0,
  pulse: null,
  toolOutputs: {},
}) as LiveTurnState;

/** Merge events in, ignoring any already held. Returns the same array when nothing is new. */
export function mergeActivityEvents(
  current: ChatActivityEvent[],
  incoming: ChatActivityEvent[],
): ChatActivityEvent[] {
  const fresh = incoming.filter(isActivityEvent);
  if (fresh.length === 0) return current;
  const byOrdinal = new Map<string, ChatActivityEvent>();
  for (const event of current) byOrdinal.set(eventKey(event), event);
  let changed = false;
  for (const event of fresh) {
    const key = eventKey(event);
    if (byOrdinal.has(key)) continue;
    byOrdinal.set(key, event);
    changed = true;
  }
  if (!changed) return current;
  return [...byOrdinal.values()].sort(
    (a, b) => a.ordinal - b.ordinal || Date.parse(a.at) - Date.parse(b.at),
  );
}

/**
 * The same event read live and read back from its row must collapse to one,
 * so the key is what both copies share. Two writers can share an ordinal in a
 * rare race (a Retry's note and the worker's start); their kinds differ.
 */
function eventKey(event: ChatActivityEvent): string {
  return `${event.ordinal}|${event.kind}|${event.callId}`;
}

function isActivityEvent(value: unknown): value is ChatActivityEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ChatActivityEvent>;
  return (
    typeof event.ordinal === "number" &&
    Number.isFinite(event.ordinal) &&
    typeof event.kind === "string" &&
    typeof event.at === "string"
  );
}

/**
 * Fold one frame of a turn's stream into its live state. Frames the state does
 * not care about (reply text is held elsewhere) still count as a sign of life.
 */
export function reduceLiveTurn(
  state: LiveTurnState,
  frame: { event: string; data: unknown },
  clientNow: number,
): LiveTurnState {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  let next = state;
  const serverNow = parseTime(data.now);
  if (serverNow !== null) next = { ...next, clockOffsetMs: serverNow - clientNow };
  const now = clientNow + next.clockOffsetMs;
  next = { ...next, lastSignalAt: now };

  if (frame.event === "turn" || frame.event === "working") {
    const turnId =
      typeof data.messageId === "string"
        ? data.messageId
        : typeof data.id === "string"
          ? data.id
          : null;
    const startedAt = parseTime(data.startedAt) ?? parseTime(data.createdAt);
    if (turnId && turnId !== next.turnId) {
      // A different turn: its events are not this one's.
      next = {
        ...next,
        turnId,
        events: [],
        lastOrdinal: 0,
        lastTextAt: null,
        pulse: null,
        toolOutputs: {},
      };
    }
    if (startedAt !== null) next = { ...next, startedAt };
    // Attaching, or attaching again: a pulse held from before may be long out of
    // date, and the server sends the current one straight after this frame.
    if (frame.event === "turn") next = { ...next, pulse: null };
  } else if (frame.event === "pulse") {
    // Null is the server saying it can no longer see the AI Model: another
    // replica took the turn over. What was last heard is out of date by then.
    if (frame.data === null) next = { ...next, pulse: null, toolOutputs: {} };
    else if (isModelPulse(frame.data)) next = { ...next, pulse: frame.data };
  } else if (frame.event === "tool_output") {
    if (typeof data.callId === "string" && typeof data.output === "string") {
      next = { ...next, toolOutputs: { ...next.toolOutputs, [data.callId]: data.output } };
    }
  } else if (frame.event === "activity") {
    const events = mergeActivityEvents(next.events, [frame.data as ChatActivityEvent]);
    if (events !== next.events) {
      next = { ...next, events, lastOrdinal: events.at(-1)?.ordinal ?? next.lastOrdinal };
    }
  } else if (frame.event === "chunk") {
    const text = typeof data.text === "string" ? data.text : "";
    if (text) next = { ...next, lastTextAt: now };
  }
  return next;
}

function isModelPulse(value: unknown): value is ModelPulse {
  if (!value || typeof value !== "object") return false;
  const pulse = value as Partial<ModelPulse>;
  return (
    typeof pulse.state === "string" &&
    typeof pulse.since === "string" &&
    typeof pulse.request === "number"
  );
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ─────────────────────────────── steps ───────────────────────────────

export type ToolStepStatus = "running" | "done" | "failed" | "held" | "stopped";

export type ToolStep = {
  kind: "tool";
  key: string;
  /** The call this step is, as a running command's output names it. */
  callId: string;
  ordinal: number;
  name: string;
  family: ChatToolFamily;
  /** "Searching Banking transactions" while it runs, "Searched …" once done. */
  label: string;
  /** The salient argument, or what the result was about. */
  target: string;
  targetIsCode: boolean;
  worker: string | null;
  status: ToolStepStatus;
  input: Record<string, unknown> | null;
  output: string | null;
  /** First line of a failure, for the collapsed row. */
  error: string | null;
  approvalId: string | null;
  images: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  /** How long the AI Model took to write this call's arguments, when that was a while. */
  draftMs: number | null;
  /**
   * Why its arguments and result are not shown: this reader sees the room's
   * view of someone else's turn, or the turn was a bound discussion.
   */
  withheld: ActivityWithheld | null;
};

export type ThinkingStep = {
  kind: "thinking";
  key: string;
  ordinal: number;
  block: string;
  /** Empty when the AI Model thought without sharing the words. */
  text: string;
  truncated: boolean;
  startedAt: number;
  endedAt: number | null;
  /** The thought happened; this reader is not shown its words. */
  withheld: ActivityWithheld | null;
};

export type WaitStep = {
  kind: "wait";
  key: string;
  ordinal: number;
  cause: string;
  label: string;
  reason: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  /** For a retry backoff, when the next attempt starts. */
  until: number | null;
  startedAt: number;
  endedAt: number | null;
};

export type NoteStep = {
  kind: "note";
  key: string;
  ordinal: number;
  /** `started`, `resumed`, `retry`, `progress`, `stopped`, or a notice code. */
  code: string;
  label: string;
  percent: number | null;
  at: number;
};

export type ActivityStep = ToolStep | ThinkingStep | WaitStep | NoteStep;

/**
 * The steps of a turn, in the order they happened.
 *
 * `finishedAt` (server ms) closes everything still open: a call the turn
 * ended in the middle of reads "stopped", a wait or a thought ends there.
 * Without it the turn is live and open steps stay open — except that any
 * later event closes an earlier thought or wait, because the employee
 * evidently moved on.
 */
export function buildActivitySteps(
  events: ChatActivityEvent[],
  options: { finishedAt?: number | null } = {},
): ActivityStep[] {
  const steps: ActivityStep[] = [];
  const callIndex = new Map<string, ToolStep>();
  const modelCalls: Array<{ ordinal: number; call: ModelCallDetail }> = [];
  const finishedAt =
    options.finishedAt ??
    (() => {
      const finish = events.find((event) => event.kind === "turn_finished");
      return finish ? Date.parse(finish.at) : null;
    })();

  /** Close open thoughts and waits at `at`: the employee moved on. */
  const closeOpen = (at: number, keepWaits = false) => {
    for (const step of steps) {
      if (step.kind === "thinking" && step.endedAt === null) step.endedAt = at;
      if (!keepWaits && step.kind === "wait" && step.endedAt === null) {
        step.endedAt = step.until !== null ? Math.min(step.until, at) : at;
      }
    }
  };

  for (const event of events) {
    const at = Date.parse(event.at);
    const detail = (event.detail ?? {}) as Record<string, unknown>;
    switch (event.kind) {
      case "tool_use": {
        closeOpen(at);
        const input = asRecord(detail.input);
        const described = describeChatToolCall(event.name, input);
        const step: ToolStep = {
          kind: "tool",
          key: `tool:${event.callId || event.ordinal}`,
          callId: event.callId,
          ordinal: event.ordinal,
          name: event.name,
          family: described.family,
          label: described.active,
          target: described.target,
          targetIsCode: described.code,
          worker: described.worker,
          status: "running",
          input,
          output: null,
          error: null,
          approvalId: null,
          images: 0,
          startedAt: at,
          endedAt: null,
          durationMs: null,
          draftMs: null,
          withheld: withheldReason(detail),
        };
        if (event.callId) callIndex.set(event.callId, step);
        steps.push(step);
        break;
      }
      case "tool_result": {
        closeOpen(at);
        const durationMs = typeof detail.durationMs === "number" ? detail.durationMs : null;
        const output = typeof detail.output === "string" ? detail.output : null;
        const hint = typeof detail.hint === "string" && detail.hint ? detail.hint : null;
        const approval = asRecord(detail.approval);
        const status: ToolStepStatus = event.isError ? "failed" : approval ? "held" : "done";
        const existing = event.callId ? callIndex.get(event.callId) : undefined;
        const described = describeChatToolCall(event.name, existing ? existing.input : null);
        if (existing) {
          existing.status = status;
          existing.label = described.done;
          existing.output = output;
          existing.error = event.isError ? firstLine(output) || "The tool reported an error" : null;
          existing.approvalId = approval ? stringOrNull(approval.id) : null;
          existing.images = typeof detail.images === "number" ? detail.images : 0;
          existing.endedAt = at;
          existing.durationMs = durationMs ?? Math.max(0, at - existing.startedAt);
          existing.withheld = existing.withheld ?? withheldReason(detail);
          if (hint) existing.target = hint;
          if (hint) existing.targetIsCode = false;
          if (event.callId) callIndex.delete(event.callId);
        } else {
          // A result whose call this reader never saw — it joined late, or the
          // runtime reported the call nowhere. It still happened.
          steps.push({
            kind: "tool",
            key: `tool:${event.callId || event.ordinal}`,
            callId: event.callId,
            ordinal: event.ordinal,
            name: event.name,
            family: described.family,
            label: described.done,
            target: hint ?? described.target,
            targetIsCode: hint ? false : described.code,
            worker: described.worker,
            status,
            input: null,
            output,
            error: event.isError ? firstLine(output) || "The tool reported an error" : null,
            approvalId: approval ? stringOrNull(approval.id) : null,
            images: typeof detail.images === "number" ? detail.images : 0,
            startedAt: durationMs !== null ? at - durationMs : at,
            endedAt: at,
            durationMs,
            draftMs: null,
            withheld: withheldReason(detail),
          });
        }
        break;
      }
      case "reasoning": {
        const text = typeof detail.text === "string" ? detail.text : "";
        const block = typeof detail.block === "string" ? detail.block : String(event.ordinal);
        const last = steps.at(-1);
        if (last && last.kind === "thinking" && last.block === block) {
          last.text += text;
          last.truncated = last.truncated || detail.truncated === true;
          last.endedAt = null;
          last.withheld = last.withheld ?? withheldReason(detail);
        } else {
          closeOpen(at);
          steps.push({
            kind: "thinking",
            key: `thinking:${event.ordinal}`,
            ordinal: event.ordinal,
            block,
            text,
            truncated: detail.truncated === true,
            startedAt: at,
            endedAt: null,
            withheld: withheldReason(detail),
          });
        }
        break;
      }
      case "waiting": {
        const cause = event.name || stringOrNull(detail.cause) || "waiting";
        if (detail.state === "done") {
          for (let i = steps.length - 1; i >= 0; i -= 1) {
            const step = steps[i];
            if (step.kind === "wait" && step.cause === cause && step.endedAt === null) {
              step.endedAt = at;
              break;
            }
          }
          break;
        }
        closeOpen(at);
        const until = parseTime(detail.until);
        steps.push({
          kind: "wait",
          key: `wait:${event.ordinal}`,
          ordinal: event.ordinal,
          cause,
          label: stringOrNull(detail.label) ?? event.summary ?? "Waiting",
          reason: stringOrNull(detail.reason),
          attempt: typeof detail.attempt === "number" ? detail.attempt : null,
          maxAttempts: typeof detail.maxAttempts === "number" ? detail.maxAttempts : null,
          until,
          startedAt: at,
          endedAt: null,
        });
        break;
      }
      case "turn_started": {
        closeOpen(at);
        const reason = stringOrNull(detail.reason) ?? "start";
        steps.push(
          note(
            event,
            reason === "start"
              ? "started"
              : reason === "retry"
                ? "retry"
                : reason === "model_back"
                  ? "model_back"
                  : "resumed",
            at,
          ),
        );
        break;
      }
      case "progress": {
        const percent = typeof detail.percent === "number" ? detail.percent : null;
        const label = stringOrNull(detail.label) ?? event.summary;
        steps.push({ ...note(event, "progress", at), label, percent });
        break;
      }
      case "notice": {
        steps.push(note(event, event.name || "notice", at));
        break;
      }
      case "stopped": {
        closeOpen(at, true);
        steps.push(note(event, "stopped", at));
        break;
      }
      case "model_call":
        modelCalls.push({ ordinal: event.ordinal, call: detail as ModelCallDetail });
        break;
      case "turn_finished":
        break;
    }
  }
  const placed = new Set<ThinkingStep>();
  for (const { ordinal, call } of modelCalls) accountForModelCall(steps, ordinal, call, placed);

  if (finishedAt !== null) {
    for (const step of steps) {
      if (step.kind === "tool" && step.status === "running") {
        step.status = "stopped";
        step.endedAt = finishedAt;
        step.durationMs = Math.max(0, finishedAt - step.startedAt);
      }
      if ((step.kind === "thinking" || step.kind === "wait") && step.endedAt === null) {
        step.endedAt =
          step.kind === "wait" && step.until !== null
            ? Math.min(step.until, finishedAt)
            : finishedAt;
      }
    }
  }
  return steps;
}

/** A thought without words shorter than this is just the model turning around. */
const MIN_SILENT_THOUGHT_MS = 3_000;
/** How long the model must take to start answering before that is a step of its own. */
const MIN_ANSWER_WAIT_MS = 10_000;
/** How long writing a tool call's arguments must take before its step says so. */
const MIN_DRAFT_MS = 2_000;
/**
 * The runtime reports a thought or a tool call over its own stream, a moment
 * after the AI Model's bytes went past, so a step and the stretch of the request
 * it belongs to are matched with this much room.
 */
const THOUGHT_MATCH_MS = 2_000;
const TOOL_CALL_MATCH_MS = 5_000;

/**
 * Fold in what one finished request says about where its time went. It is what
 * the steps cannot say: when a thought really started and ended, that the model
 * thought for a minute and shared no words, that it took a while to write a tool
 * call or to start answering at all.
 */
function accountForModelCall(
  steps: ActivityStep[],
  ordinal: number,
  call: ModelCallDetail,
  placed: Set<ThinkingStep>,
): void {
  if (!Array.isArray(call.phases)) return;
  call.phases.forEach((phase, index) => {
    const start = Date.parse(phase.startedAt);
    if (!Number.isFinite(start) || typeof phase.ms !== "number") return;
    const end = start + phase.ms;
    if (phase.kind === "thinking") {
      // Only a stretch that wrote words has a step to find. Every request reads
      // as thinking for a moment when its first bytes arrive, and that moment
      // must not claim the next request's thought.
      const thought = phase.chars
        ? steps.find(
            (step): step is ThinkingStep =>
              step.kind === "thinking" &&
              !placed.has(step) &&
              step.startedAt >= start - THOUGHT_MATCH_MS &&
              step.startedAt <= end + THOUGHT_MATCH_MS,
          )
        : undefined;
      if (thought) {
        placed.add(thought);
        thought.startedAt = Math.min(thought.startedAt, start);
        thought.endedAt = end;
      } else if (phase.ms >= MIN_SILENT_THOUGHT_MS) {
        insertByTime(steps, {
          kind: "thinking",
          key: `thinking:call:${ordinal}:${index}`,
          ordinal,
          block: `call:${ordinal}:${index}`,
          text: "",
          truncated: false,
          startedAt: start,
          endedAt: end,
          withheld: null,
        });
      }
    } else if (phase.kind === "waiting" && phase.ms >= MIN_ANSWER_WAIT_MS) {
      insertByTime(steps, {
        kind: "wait",
        key: `wait:call:${ordinal}`,
        ordinal,
        cause: "model_first_answer",
        label: "Waited for the AI Model to start answering",
        reason: null,
        attempt: null,
        maxAttempts: null,
        until: null,
        startedAt: start,
        endedAt: end,
      });
    } else if (phase.kind === "tool_input" && phase.ms >= MIN_DRAFT_MS) {
      const wanted = phase.tool?.replace(/^genosyn_/, "");
      const tool = steps.find(
        (step): step is ToolStep =>
          step.kind === "tool" &&
          step.worker === null &&
          step.draftMs === null &&
          Math.abs(step.startedAt - end) <= TOOL_CALL_MATCH_MS &&
          // `call_tool` is reported as the tool it reached, so its name cannot match.
          (wanted === "call_tool" || step.name.replace(/^genosyn_/, "") === wanted),
      );
      if (tool) tool.draftMs = phase.ms;
    }
  });
}

function stepTime(step: ActivityStep): number {
  return step.kind === "note" ? step.at : step.startedAt;
}

function insertByTime(steps: ActivityStep[], step: ActivityStep): void {
  const at = steps.findIndex((other) => stepTime(other) > stepTime(step));
  if (at < 0) steps.push(step);
  else steps.splice(at, 0, step);
}

/**
 * A thought is over once the AI Model has moved on, which its stream says before
 * any later step does: it can spend a long time writing a tool call after it
 * stops thinking. Changes the steps in place, so hand it ones just built.
 */
export function closeThoughtsBefore(
  steps: ActivityStep[],
  pulse: Pick<ModelPulse, "state" | "since"> | null,
): ActivityStep[] {
  if (!pulse || pulse.state === "thinking" || pulse.state === "preparing") return steps;
  const movedOn = Date.parse(pulse.since);
  if (!Number.isFinite(movedOn)) return steps;
  for (const step of steps) {
    // Its last words can land just after the stream moved on, over their own path.
    if (step.kind === "thinking" && step.endedAt === null) {
      step.endedAt = Math.max(step.startedAt, movedOn);
    }
  }
  return steps;
}

/** The thought in progress, when the AI Model is sharing its words. */
export function thoughtInProgress(steps: ActivityStep[]): ThinkingStep | null {
  const last = steps.at(-1);
  return last?.kind === "thinking" && last.endedAt === null && last.text.trim() ? last : null;
}

function note(event: ChatActivityEvent, code: string, at: number): NoteStep {
  return {
    kind: "note",
    key: `note:${event.ordinal}:${code}`,
    ordinal: event.ordinal,
    code,
    label: event.summary,
    percent: null,
    at,
  };
}

/** What the collapsed line of a turn counts, from its steps. */
export function countSteps(steps: ActivityStep[]): {
  tools: number;
  failed: number;
  held: number;
  running: number;
  thinking: number;
} {
  let tools = 0;
  let failed = 0;
  let held = 0;
  let running = 0;
  let thinking = 0;
  for (const step of steps) {
    if (step.kind === "thinking") thinking += 1;
    if (step.kind !== "tool") continue;
    tools += 1;
    if (step.status === "failed") failed += 1;
    if (step.status === "held") held += 1;
    if (step.status === "running") running += 1;
  }
  return { tools, failed, held, running, thinking };
}

/** The steps a list shows: everything but the bookkeeping a person never needs. */
export function visibleSteps(steps: ActivityStep[]): ActivityStep[] {
  return steps.filter(
    (step) => !(step.kind === "note" && (step.code === "started" || step.code === "progress")),
  );
}

/** The employee's own latest milestone, if it reported one. */
export function latestProgress(
  events: ChatActivityEvent[],
): { percent: number; label: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind !== "progress") continue;
    const detail = (event.detail ?? {}) as Record<string, unknown>;
    if (typeof detail.percent === "number" && typeof detail.label === "string") {
      return { percent: detail.percent, label: detail.label };
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function firstLine(text: string | null): string {
  if (!text) return "";
  return (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 200);
}
