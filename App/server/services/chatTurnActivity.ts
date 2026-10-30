import { AppDataSource } from "../db/datasource.js";
import { ConversationActivityEvent } from "../db/entities/ConversationActivityEvent.js";
import type { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { CHAT_HARD_TIMEOUT_MS } from "./chat.js";
import {
  approvalHeldIn,
  describeChatToolCall,
  formatElapsed,
  isQuietChatTool,
  type ChatActivityEvent,
  type ChatActivityKind,
  type TurnActivitySummary,
} from "../../shared/chatActivity.js";
import { redactSensitiveText, redactSensitiveValue } from "./approvalRedaction.js";
import type {
  AgentProgress,
  CompactionInfo,
  ModelOutage,
  ModelRetryInfo,
  RuntimeWait,
  ToolResult,
} from "./agent/types.js";
import type { LiveTurn } from "./chatTurnLive.js";

/**
 * The record of what an AI Employee did while it answered a chat message.
 *
 * ## What is recorded
 *
 * Everything the runtime reports while a turn runs — each tool call and its
 * result, the AI Model's thinking summary, progress milestones, the reasons
 * the turn waits (another reply in the thread, a subscription model's lock, a
 * retry after a model error), compaction — becomes one
 * {@link ConversationActivityEvent} row, written in the order it was observed,
 * and is handed to the turn's live record (`chatTurnLive.ts`) in the same
 * tick so a watching browser sees it immediately. The reply's own text is not
 * an event: it is the reply, and it is persisted on the reply's row.
 *
 * ## Security
 *
 * The feed is shown to whoever can read the conversation, so it never holds
 * more than the transcript would. Arguments go through the same redaction as
 * an Approval preview (secret-named keys replaced, credential-shaped text
 * scrubbed), outputs and thinking through the shared text redaction, and the
 * exact values of the company Secrets the turn's tools were handed are
 * removed wherever they appear. Everything is clipped: this is a feed, not an
 * archive. A turn bound to a discussion records steps without their payloads
 * (`chat.ts` strips them at the seam), and a browser field's typed value is
 * never kept.
 *
 * ## Why writes are chained
 *
 * Tool results can arrive out of order when calls overlap, so ordinals are
 * assigned synchronously as events are observed, results pair with their call
 * by `callId`, and every insert is chained on one promise. A failed insert is
 * logged and swallowed: the feed must never fail the work.
 */

/** Characters kept of any one string argument. */
const INPUT_STRING_CHARS = 2_000;
/** Characters of a whole argument object, serialized, before fields are dropped. */
const INPUT_JSON_CHARS = 8_000;
/** Characters of a tool's output kept; a command's output gets more. */
const OUTPUT_CHARS = 4_000;
const COMMAND_OUTPUT_CHARS = 8_000;
/** Thinking kept per block; the rest is summarized as truncated. */
const REASONING_BLOCK_CHARS = 4_000;
/** Thinking is flushed when it goes quiet for this long, so it streams in chunks. */
const REASONING_FLUSH_MS = 1_500;
const SUMMARY_CHARS = 300;
/** A runaway backstop: past this many events a turn records only its end. */
const MAX_EVENTS_PER_TURN = 1_000;

const COMMAND_TOOLS = new Set(["bash", "repository_run_command"]);

export type ChatTurnActivityScope = {
  companyId: string;
  conversationId: string;
  messageId: string;
  attempt: number;
};

type OpenCall = { name: string; startedAt: number; key: string };

/** The causes the server words itself; any other cause carries its own label. */
const WAIT_LABELS: Record<string, string> = {
  thread_busy: "Waiting for the previous reply in this conversation to finish",
  model_lock: "Waiting for the AI Model, which answers one turn at a time",
  model_outage: "The AI Model's server stopped answering — waiting for it",
};

export class ChatTurnActivityRecorder {
  private nextOrdinal: number;
  private chain: Promise<void> = Promise.resolve();
  private recorded = 0;
  private closed = false;
  private readonly openCalls = new Map<string, OpenCall>();
  /** Calls a runtime reported without an id, oldest first, to pair by name. */
  private readonly anonymousCalls: OpenCall[] = [];
  private readonly openWaits = new Map<string, number>();
  private reasoningBlock: string | null = null;
  private reasoningText = "";
  private reasoningTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reasoningKept = new Map<string, number>();
  private sensitive: string[] = [];
  private lastBackgroundCount = 0;
  private stats = { steps: 0, failed: 0, held: 0, waitedMs: 0, reasoning: false };
  private stoppedRecorded = false;
  private startedRecorded = false;

  constructor(
    private readonly scope: ChatTurnActivityScope,
    firstOrdinal: number,
    private readonly options: {
      live?: LiveTurn | null;
      onEvent?: (event: ChatActivityEvent) => void;
      now?: () => number;
    } = {},
  ) {
    this.nextOrdinal = firstOrdinal;
  }

  /** The ordinal of the last event recorded, or one before the first. */
  get lastOrdinal(): number {
    return this.nextOrdinal - 1;
  }

  /** Whether a stop has been written, so a finalizer does not write two. */
  get hasRecordedStop(): boolean {
    return this.stoppedRecorded;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * The exact values of the company Secrets this turn's tools were handed.
   * Any of them seen in an argument, an output or a thought is replaced.
   */
  setSensitiveValues(values: Iterable<string>): void {
    this.sensitive = [...new Set([...values].filter((value) => value.length >= 6))].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** The turn began doing work — the reply lease is held and the model is about to run. */
  turnStarted(reason: "start" | "resume" | "retry"): void {
    if (this.startedRecorded) return;
    this.startedRecorded = true;
    this.closeWait("thread_busy");
    const label =
      reason === "retry"
        ? "Started again"
        : reason === "resume"
          ? "Resumed after a server restart"
          : "Started working";
    this.record({
      kind: "turn_started",
      summary: label,
      detail: { attempt: this.scope.attempt, reason },
    });
  }

  toolUse(name: string, input: Record<string, unknown>, callId?: string): void {
    if (isQuietChatTool(name)) return;
    this.flushReasoning();
    const now = this.now();
    const key = callId || `anonymous:${this.nextOrdinal}`;
    const call: OpenCall = { name, startedAt: now, key };
    if (callId) this.openCalls.set(callId, call);
    else this.anonymousCalls.push(call);
    const safeInput = this.sanitizeInput(name, input);
    const described = describeChatToolCall(name, safeInput);
    this.stats.steps += 1;
    this.record({
      kind: "tool_use",
      name,
      callId: key,
      summary: [described.active, described.target].filter(Boolean).join(" · "),
      detail: { input: safeInput, worker: described.worker },
    });
  }

  toolResult(name: string, result: ToolResult, callId?: string): void {
    if (isQuietChatTool(name)) return;
    this.flushReasoning();
    const now = this.now();
    let call: OpenCall | undefined;
    if (callId && this.openCalls.has(callId)) {
      call = this.openCalls.get(callId);
      this.openCalls.delete(callId);
    } else if (!callId) {
      const index = this.anonymousCalls.findIndex((candidate) => candidate.name === name);
      if (index >= 0) call = this.anonymousCalls.splice(index, 1)[0];
    }
    // A result whose call was never seen still happened; it counts as a step.
    if (!call) this.stats.steps += 1;
    const content = typeof result.content === "string" ? result.content : "";
    const output = this.sanitizeOutput(name, content);
    const approval = approvalHeldIn(content);
    const hint = this.resultHint(content);
    const isError = result.isError === true;
    if (isError) this.stats.failed += 1;
    if (approval) this.stats.held += 1;
    const described = describeChatToolCall(name, null);
    const outcome = isError
      ? `failed: ${firstLine(output ?? "") || "the tool reported an error"}`
      : approval
        ? "waiting for approval"
        : hint;
    this.record({
      kind: "tool_result",
      name,
      callId: call?.key ?? callId ?? "",
      summary: [described.done, outcome].filter(Boolean).join(" · "),
      detail: {
        output,
        durationMs: call ? Math.max(0, now - call.startedAt) : null,
        ...(hint ? { hint } : {}),
        ...(result.images?.length ? { images: result.images.length } : {}),
        ...(approval ? { approval } : {}),
        worker: described.worker,
      },
      isError,
    });
  }

  /** A chunk of the AI Model's thinking summary, from one reasoning block. */
  reasoning(delta: string, block: string): void {
    if (!delta || this.closed) return;
    if (this.reasoningBlock !== null && this.reasoningBlock !== block) this.flushReasoning();
    const kept = this.reasoningKept.get(block) ?? 0;
    if (kept >= REASONING_BLOCK_CHARS) return;
    const room = REASONING_BLOCK_CHARS - kept;
    const piece = delta.length > room ? delta.slice(0, room) : delta;
    this.reasoningKept.set(block, kept + piece.length);
    this.reasoningBlock = block;
    this.reasoningText += piece;
    this.stats.reasoning = true;
    if (this.reasoningTimer) clearTimeout(this.reasoningTimer);
    this.reasoningTimer = setTimeout(() => this.flushReasoning(), REASONING_FLUSH_MS);
    this.reasoningTimer.unref?.();
  }

  /** A reasoning block ended; whatever is buffered for it is written now. */
  reasoningEnd(block: string): void {
    if (this.reasoningBlock === block) this.flushReasoning();
  }

  progress(progress: AgentProgress): void {
    this.flushReasoning();
    this.record({
      kind: "progress",
      summary: `${progress.percent}% · ${progress.label}`.slice(0, SUMMARY_CHARS),
      detail: { percent: progress.percent, label: this.scrub(progress.label).slice(0, 200) },
    });
  }

  /** The turn started waiting on something outside the employee. */
  waiting(
    cause: string,
    extra: {
      label?: string;
      until?: Date | null;
      attempt?: number | null;
      maxAttempts?: number | null;
      reason?: string | null;
    } = {},
  ): void {
    this.flushReasoning();
    if (cause !== "model_retry") this.openWaits.set(cause, this.now());
    const label = extra.label ?? WAIT_LABELS[cause] ?? "Waiting";
    this.record({
      kind: "waiting",
      name: cause,
      summary: label,
      detail: {
        cause,
        state: "waiting",
        label,
        until: extra.until ? extra.until.toISOString() : null,
        attempt: extra.attempt ?? null,
        maxAttempts: extra.maxAttempts ?? null,
        reason: extra.reason ? this.scrub(extra.reason).slice(0, 200) : null,
      },
    });
  }

  /** A wait this recorder opened has ended. */
  waitDone(cause: string): void {
    if (!this.openWaits.has(cause)) return;
    this.closeWait(cause);
    this.record({
      kind: "waiting",
      name: cause,
      summary: "Done waiting",
      detail: { cause, state: "done", label: "Done waiting" },
    });
  }

  modelRetry(info: ModelRetryInfo): void {
    const delayMs = Math.max(0, info.delayMs);
    this.stats.waitedMs += delayMs;
    this.waiting("model_retry", {
      label: `The AI Model's service failed (${info.reason}) — retrying`,
      until: delayMs > 0 ? new Date(this.now() + delayMs) : null,
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      reason: info.reason,
    });
  }

  modelOutage(outage: ModelOutage): void {
    if (outage.state === "waiting") this.waiting("model_outage");
    else this.waitDone("model_outage");
  }

  /** A runtime-level wait, such as a subscription model's lock. */
  runtimeWait(wait: RuntimeWait): void {
    if (wait.state === "waiting") this.waiting(wait.cause, { label: wait.label });
    else this.waitDone(wait.cause);
  }

  compact(info: CompactionInfo): void {
    this.notice(
      "compact",
      info.reason === "overflow"
        ? "The conversation outgrew the AI Model's context window; older parts were compacted"
        : "Compacted older parts of the conversation to fit the AI Model's context window",
    );
  }

  apiKeyFailover(change: { status?: number }): void {
    this.notice(
      "key_failover",
      `The AI Model refused one of its API keys${typeof change.status === "number" ? ` (HTTP ${change.status})` : ""}; continued on another`,
    );
  }

  servedModelChange(change: { from: string; to: string }): void {
    this.notice(
      "served_model",
      `The AI Model's server now serves ${this.scrub(change.to).slice(0, 80)}; switched to it`,
    );
  }

  backgroundWork(pendingGroups: number): void {
    if (pendingGroups === this.lastBackgroundCount) return;
    this.lastBackgroundCount = pendingGroups;
    if (pendingGroups <= 0) return;
    this.notice(
      "background_work",
      `${pendingGroups} group${pendingGroups === 1 ? "" : "s"} of parallel work still running`,
    );
  }

  notice(code: string, label: string): void {
    this.flushReasoning();
    const safe = this.scrub(label).slice(0, SUMMARY_CHARS);
    this.record({ kind: "notice", name: code, summary: safe, detail: { code, label: safe } });
  }

  /** A Member stopped the turn. */
  stopped(): void {
    if (this.stoppedRecorded) return;
    this.stoppedRecorded = true;
    this.flushReasoning();
    this.record({ kind: "stopped", summary: "Stopped by a Member", detail: { by: "member" } });
  }

  /** The figures for {@link TurnActivitySummary}, as of now. Records nothing. */
  summarize(args: { status: string; startedAt: Date; endedAt?: Date }): TurnActivitySummary {
    const endedAt = args.endedAt ?? new Date(this.now());
    let waitedMs = this.stats.waitedMs;
    for (const startedAt of this.openWaits.values())
      waitedMs += Math.max(0, endedAt.getTime() - startedAt);
    return {
      startedAt: args.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - args.startedAt.getTime()),
      steps: this.stats.steps,
      failed: this.stats.failed,
      held: this.stats.held,
      waitedMs,
      reasoning: this.stats.reasoning,
      // The finish event itself takes the next ordinal.
      lastOrdinal: this.nextOrdinal,
      status: args.status,
    };
  }

  /**
   * Write the turn's end and wait for every row to land. Called once the
   * reply's row is final, with the summary that row now carries.
   */
  async finish(summary: TurnActivitySummary): Promise<void> {
    this.flushReasoning();
    for (const cause of [...this.openWaits.keys()]) this.closeWait(cause);
    this.record(
      {
        kind: "turn_finished",
        summary: [
          `Worked for ${formatElapsed(summary.durationMs)}`,
          summary.steps > 0 ? `${summary.steps} step${summary.steps === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        detail: { ...summary },
        isError: summary.status === "error",
      },
      true,
    );
    this.closed = true;
    await this.chain;
  }

  /** Wait for every queued row without ending the record. */
  async flush(): Promise<void> {
    this.flushReasoning();
    await this.chain;
  }

  /** Stop accepting events: the turn is no longer running here. */
  async close(): Promise<void> {
    this.flushReasoning();
    this.closed = true;
    await this.chain;
  }

  private closeWait(cause: string): void {
    const startedAt = this.openWaits.get(cause);
    if (startedAt === undefined) return;
    this.openWaits.delete(cause);
    this.stats.waitedMs += Math.max(0, this.now() - startedAt);
  }

  private flushReasoning(): void {
    if (this.reasoningTimer) {
      clearTimeout(this.reasoningTimer);
      this.reasoningTimer = null;
    }
    const block = this.reasoningBlock;
    const text = this.reasoningText;
    this.reasoningBlock = null;
    this.reasoningText = "";
    if (block === null || !text.trim()) return;
    const truncated = (this.reasoningKept.get(block) ?? 0) >= REASONING_BLOCK_CHARS;
    const safe = this.scrub(text);
    this.record({
      kind: "reasoning",
      summary: firstLine(safe).slice(0, 160),
      detail: { text: safe, block, ...(truncated ? { truncated: true } : {}) },
    });
  }

  private record(
    event: {
      kind: ChatActivityKind;
      name?: string;
      callId?: string;
      summary?: string;
      detail?: Record<string, unknown>;
      isError?: boolean;
    },
    final = false,
  ): void {
    if (this.closed) return;
    if (!final && this.recorded >= MAX_EVENTS_PER_TURN) return;
    this.recorded += 1;
    const ordinal = this.nextOrdinal++;
    const occurredAt = new Date(this.now());
    const dto: ChatActivityEvent = {
      ordinal,
      attempt: this.scope.attempt,
      kind: event.kind,
      name: event.name ?? "",
      callId: event.callId ?? "",
      summary: this.scrub(event.summary ?? "").slice(0, SUMMARY_CHARS),
      detail: event.detail ?? null,
      isError: event.isError === true,
      at: occurredAt.toISOString(),
    };
    try {
      this.options.live?.pushEvent(dto);
    } catch {
      // The live record is best effort.
    }
    try {
      this.options.onEvent?.(dto);
    } catch {
      // A disconnected subscriber is not a failed turn.
    }
    this.chain = this.chain
      .then(async () => {
        const repo = AppDataSource.getRepository(ConversationActivityEvent);
        await repo.insert({
          companyId: this.scope.companyId,
          conversationId: this.scope.conversationId,
          messageId: this.scope.messageId,
          ordinal,
          attempt: this.scope.attempt,
          kind: dto.kind,
          name: dto.name,
          callId: dto.callId,
          summary: dto.summary,
          detailJson: dto.detail === null ? "" : safeJson(dto.detail),
          isError: dto.isError,
          occurredAt,
        });
      })
      .catch((error) => {
        console.warn(
          `[chat:activity] could not record activity for message ${this.scope.messageId}:`,
          error instanceof Error ? error.message : error,
        );
      });
  }

  /** Redacted text with the turn's own Secret values removed. */
  private scrub(text: string): string {
    let out = redactSensitiveText(text);
    for (const value of this.sensitive) {
      if (out.includes(value)) out = out.split(value).join("[redacted secret]");
    }
    return out;
  }

  private sanitizeInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
    const source: Record<string, unknown> =
      input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    // A value typed into a page can be anything — a password included — and
    // the live browser panel is where a watching admin sees it.
    if (/(^|_)browser_fill$/.test(name.replace(/^\[worker:[^\]]*\]\s*/, "")) && "value" in source) {
      source.value = "[typed text hidden]";
    }
    const redacted = redactSensitiveValue(source) as Record<string, unknown>;
    const clipped = this.clipValue(redacted, 0) as Record<string, unknown>;
    if (safeJson(clipped).length <= INPUT_JSON_CHARS) return clipped;
    // Too large as a whole: keep each field, shortened hard.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(clipped)) {
      const text = typeof value === "string" ? value : safeJson(value);
      out[key] = clipText(text, 400);
    }
    return out;
  }

  private clipValue(value: unknown, depth: number): unknown {
    if (typeof value === "string") return clipText(this.scrub(value), INPUT_STRING_CHARS);
    if (depth >= 4)
      return Array.isArray(value)
        ? `[${value.length} items]`
        : value && typeof value === "object"
          ? "{…}"
          : value;
    if (Array.isArray(value)) {
      const items = value.slice(0, 20).map((item) => this.clipValue(item, depth + 1));
      if (value.length > 20) items.push(`… ${value.length - 20} more`);
      return items;
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 40)
          .map(([key, child]) => [key, this.clipValue(child, depth + 1)]),
      );
    }
    return value;
  }

  private sanitizeOutput(name: string, content: string): string | null {
    if (!content) return "";
    const bare = name.replace(/^\[worker:[^\]]*\]\s*/, "");
    const cap = COMMAND_TOOLS.has(bare) ? COMMAND_OUTPUT_CHARS : OUTPUT_CHARS;
    // Clip before redacting: a page snapshot can be a megabyte, and the
    // patterns only need to see what will be kept (plus a margin for a token
    // straddling the cut).
    const head = content.length > cap * 2 ? content.slice(0, cap * 2) : content;
    const safe = this.scrub(head);
    return safe.length > cap || content.length > cap * 2
      ? `${safe.slice(0, cap)}\n… [${Math.max(0, content.length - cap).toLocaleString("en-US")} more characters]`
      : safe;
  }

  /**
   * What a result was about, from its own fields — an email's subject and
   * sender, a record's title — so a finished step can say more than its verb.
   */
  private resultHint(content: string): string | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") || trimmed.length > 200_000) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const nested = [root, root.message, root.thread, root.record, root.result].filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    );
    let subject: string | null = null;
    let from: string | null = null;
    for (const node of nested) {
      subject ??= textField(node, "subject") ?? textField(node, "title");
      from ??= senderOf(node.from);
    }
    const parts = [
      subject ? `“${clipText(subject.replace(/\s+/g, " "), 70)}”` : "",
      from ? `from ${clipText(from, 60)}` : "",
    ].filter(Boolean);
    if (parts.length === 0) return null;
    return this.scrub(parts.join(" · "));
  }
}

function textField(node: Record<string, unknown>, key: string): string | null {
  const value = node[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function senderOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return senderOf(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textField(record, "name") ?? textField(record, "address") ?? textField(record, "email");
  }
  return null;
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function clipText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… [${(text.length - cap).toLocaleString("en-US")} more characters]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// ───────────────────────────── reading ─────────────────────────────

/**
 * When the Member last asked for this turn: when it was sent, or when a
 * failed reply was retried. A turn's deadline is always set to that moment
 * plus the turn limit, and a restart keeps it, so a turn resumed after a
 * restart counts the whole wait while a retried one starts its clock again.
 */
export function turnAcceptedAt(
  message: Pick<ConversationMessage, "createdAt" | "turnDeadlineAt">,
): Date {
  return message.turnDeadlineAt
    ? new Date(message.turnDeadlineAt.getTime() - CHAT_HARD_TIMEOUT_MS)
    : message.createdAt;
}

/** The wire shape of a stored row. */
export function toChatActivityEvent(row: ConversationActivityEvent): ChatActivityEvent {
  let detail: Record<string, unknown> | null = null;
  if (row.detailJson) {
    try {
      const parsed = JSON.parse(row.detailJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      detail = null;
    }
  }
  const occurredAt = row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt);
  return {
    ordinal: row.ordinal,
    attempt: row.attempt,
    kind: row.kind,
    name: row.name,
    callId: row.callId,
    summary: row.summary,
    detail,
    isError: row.isError,
    at: Number.isNaN(occurredAt.getTime()) ? new Date(0).toISOString() : occurredAt.toISOString(),
  };
}

/** Where a new recorder's ordinals start: after everything the turn already has. */
export async function nextChatActivityOrdinal(messageId: string): Promise<number> {
  const last = await AppDataSource.getRepository(ConversationActivityEvent).findOne({
    where: { messageId },
    order: { ordinal: "DESC" },
    select: { id: true, ordinal: true },
  });
  return (last?.ordinal ?? 0) + 1;
}

/** The newest recorded event for a turn, or null. */
export async function lastChatActivity(messageId: string): Promise<ChatActivityEvent | null> {
  const last = await AppDataSource.getRepository(ConversationActivityEvent).findOne({
    where: { messageId },
    order: { ordinal: "DESC" },
  });
  return last ? toChatActivityEvent(last) : null;
}

/** Events after `after`, oldest first, bounded. Read by `(messageId, ordinal)`. */
export async function listChatActivity(
  messageId: string,
  after: number,
  limit = 500,
): Promise<ChatActivityEvent[]> {
  const rows = await AppDataSource.getRepository(ConversationActivityEvent)
    .createQueryBuilder("event")
    .where("event.messageId = :messageId", { messageId })
    .andWhere("event.ordinal > :after", { after })
    .orderBy("event.ordinal", "ASC")
    .addOrderBy("event.occurredAt", "ASC")
    .take(Math.min(Math.max(1, limit), 1_000))
    .getMany();
  return rows.map(toChatActivityEvent);
}

/**
 * Record events for a turn this process is not running — a stop that landed
 * on another replica's turn, a Retry the Member asked for. Ordinals continue
 * after whatever the turn has.
 */
export async function recordDetachedChatActivity(
  scope: ChatTurnActivityScope,
  write: (recorder: ChatTurnActivityRecorder) => void,
): Promise<ChatTurnActivityRecorder> {
  const recorder = new ChatTurnActivityRecorder(
    scope,
    await nextChatActivityOrdinal(scope.messageId),
  );
  write(recorder);
  await recorder.flush();
  return recorder;
}

/**
 * The summary of a turn finalized outside its worker, counted from its rows —
 * for a stop that finalized a turn running on another replica.
 */
export async function summarizeChatActivity(args: {
  messageId: string;
  status: string;
  startedAt: Date;
  endedAt: Date;
}): Promise<TurnActivitySummary> {
  const events = await listChatActivity(args.messageId, 0, 1_000);
  let steps = 0;
  let failed = 0;
  let held = 0;
  let reasoning = false;
  const used = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool_use") {
      steps += 1;
      used.add(event.callId);
    } else if (event.kind === "tool_result") {
      if (!used.has(event.callId)) steps += 1;
      if (event.isError) failed += 1;
      if (event.detail && typeof event.detail.approval === "object") held += 1;
    } else if (event.kind === "reasoning") {
      reasoning = true;
    }
  }
  return {
    startedAt: args.startedAt.toISOString(),
    endedAt: args.endedAt.toISOString(),
    durationMs: Math.max(0, args.endedAt.getTime() - args.startedAt.getTime()),
    steps,
    failed,
    held,
    waitedMs: 0,
    reasoning,
    lastOrdinal: (events.at(-1)?.ordinal ?? 0) + 1,
    status: args.status,
  };
}
