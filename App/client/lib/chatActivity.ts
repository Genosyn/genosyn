import {
  describeChatToolCall,
  type ChatActivityEvent,
  type ChatToolFamily,
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
};

export const EMPTY_LIVE_TURN: LiveTurnState = Object.freeze({
  turnId: null,
  startedAt: null,
  clockOffsetMs: 0,
  lastSignalAt: null,
  lastTextAt: null,
  events: [],
  lastOrdinal: 0,
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
      next = { ...next, turnId, events: [], lastOrdinal: 0, lastTextAt: null };
    }
    if (startedAt !== null) next = { ...next, startedAt };
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
  const callIndex = new Map<string, number>();
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
          withheld: withheldReason(detail),
        };
        if (event.callId) callIndex.set(event.callId, steps.length);
        steps.push(step);
        break;
      }
      case "tool_result": {
        closeOpen(at);
        const index = event.callId ? callIndex.get(event.callId) : undefined;
        const durationMs = typeof detail.durationMs === "number" ? detail.durationMs : null;
        const output = typeof detail.output === "string" ? detail.output : null;
        const hint = typeof detail.hint === "string" && detail.hint ? detail.hint : null;
        const approval = asRecord(detail.approval);
        const status: ToolStepStatus = event.isError ? "failed" : approval ? "held" : "done";
        const existing = index !== undefined ? steps[index] : undefined;
        const described = describeChatToolCall(
          event.name,
          existing?.kind === "tool" ? existing.input : null,
        );
        if (existing && existing.kind === "tool") {
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
      case "turn_finished":
        break;
    }
  }

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
