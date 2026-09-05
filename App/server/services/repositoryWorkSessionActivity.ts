import { AppDataSource } from "../db/datasource.js";
import {
  RepositoryWorkSessionEvent,
  type RepositoryWorkSessionEventKind,
} from "../db/entities/RepositoryWorkSessionEvent.js";
import type { AgentProgress, CompactionInfo, ModelRetryInfo, ToolResult } from "./agent/types.js";
import type { SessionStep } from "./repositorySessionTools.js";

/**
 * The live record of a work session turn, and the handle that can stop it.
 *
 * ## What is recorded
 *
 * Everything the agent loop reports while a turn runs — narration, each tool
 * call and its result, step-list updates, compaction, retries — is written as
 * a {@link RepositoryWorkSessionEvent} row as it happens. The TypeORM
 * subscriber turns each write into a `resource.changed` frame for the
 * repository, so the open session's page fetches the new rows and renders
 * them while the employee is still working. This is what an agentic coding
 * tool shows in its terminal, persisted: a Member can watch it live, and
 * anyone can read afterwards how the diff came to be.
 *
 * ## Why writes are serialized and bounded
 *
 * Read-only tool calls now run concurrently, so `tool_result`s can arrive in
 * a different order from their `tool_use`s. Every write is chained on one
 * promise so ordinals are assigned and inserted in the order events were
 * *observed*, and a `tool_result` is paired with its call by `callId` rather
 * than by position. Each detail is clipped before it is stored: this is a
 * feed, not an archive, and the loop already caps what the model itself sees.
 *
 * ## Stopping
 *
 * A Member can stop a running turn. The registry below maps a session id to
 * the turn's abort controller; stopping aborts the model stream and every
 * tool observing the signal, and records who did it. It is process-local for
 * the same reason the session runner is: one App process owns a turn.
 */

/** Characters of a tool result kept in the feed. Command output gets more. */
const RESULT_DETAIL_CHARS = 6_000;
const COMMAND_DETAIL_CHARS = 16_000;

/** Characters of any single tool argument kept in the feed. */
const INPUT_DETAIL_CHARS = 4_000;

/** Narration is flushed when it goes quiet for this long, so it streams. */
const TEXT_FLUSH_MS = 1_500;

/** Narration a single `text` event may carry before it is split. */
const TEXT_EVENT_CHARS = 8_000;

export type RunningSessionTurn = {
  controller: AbortController;
  recorder: SessionActivityRecorder;
  /** The Member who stopped it, once somebody has. */
  stoppedByUserId: string | null;
};

const running = new Map<string, RunningSessionTurn>();

export function registerRunningSessionTurn(sessionId: string, turn: RunningSessionTurn): void {
  running.set(sessionId, turn);
}

export function unregisterRunningSessionTurn(sessionId: string): void {
  running.delete(sessionId);
}

export function runningSessionTurn(sessionId: string): RunningSessionTurn | null {
  return running.get(sessionId) ?? null;
}

/**
 * Stop a running turn. Returns false when this process is not running one
 * for the session — it finished, it never started, or another process owns
 * it — so the route can say so rather than pretend.
 */
export function stopRunningSessionTurn(sessionId: string, userId: string): boolean {
  const turn = running.get(sessionId);
  if (!turn) return false;
  if (turn.stoppedByUserId === null) {
    turn.stoppedByUserId = userId;
    turn.recorder.stopped(userId);
    turn.controller.abort();
  }
  return true;
}

export type ActivityEventInput = {
  kind: RepositoryWorkSessionEventKind;
  name?: string;
  callId?: string;
  summary?: string;
  detail?: unknown;
  isError?: boolean;
};

export class SessionActivityRecorder {
  private nextOrdinal: number;
  private chain: Promise<void> = Promise.resolve();
  private textBuffer = "";
  private textTimer: ReturnType<typeof setTimeout> | null = null;
  /** Narration since the last tool result: the turn's closing report. */
  private trailingText = "";
  private closed = false;

  constructor(
    private readonly scope: {
      companyId: string;
      repositoryId: string;
      sessionId: string;
      turnId: string;
    },
    firstOrdinal: number,
  ) {
    this.nextOrdinal = firstOrdinal;
  }

  /** The ordinal the next event will take, for a test or a status line. */
  get ordinal(): number {
    return this.nextOrdinal;
  }

  /**
   * The narration written after the last tool call, if any.
   *
   * A model narrates as it works — "Let me look at the router first" — and
   * then reports when it is done. The whole stream used to be the reply; now
   * the narration lives in the feed and the report is the reply, which is
   * what the human reading the diff actually wants beside it.
   */
  get closingText(): string {
    return (this.trailingText + this.textBuffer).trim();
  }

  text(delta: string): void {
    if (!delta || this.closed) return;
    this.textBuffer += delta;
    if (this.textBuffer.length >= TEXT_EVENT_CHARS) {
      this.flushText();
      return;
    }
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = setTimeout(() => this.flushText(), TEXT_FLUSH_MS);
    if (typeof this.textTimer.unref === "function") this.textTimer.unref();
  }

  toolUse(name: string, input: Record<string, unknown>, callId?: string): void {
    this.flushText();
    this.trailingText = "";
    this.record({
      kind: "tool_use",
      name,
      callId,
      summary: describeToolUse(name, input),
      detail: { input: clipInput(input) },
    });
  }

  toolResult(name: string, result: ToolResult, callId?: string): void {
    this.flushText();
    this.trailingText = "";
    const cap = name === "repository_run_command" ? COMMAND_DETAIL_CHARS : RESULT_DETAIL_CHARS;
    this.record({
      kind: "tool_result",
      name,
      callId,
      summary: describeToolResult(name, result),
      detail: { output: clipText(result.content, cap) },
      isError: result.isError === true,
    });
  }

  steps(steps: SessionStep[]): void {
    this.flushText();
    const done = steps.filter((step) => step.status === "completed").length;
    this.record({
      kind: "steps",
      summary: `${done} of ${steps.length} steps done`,
      detail: { steps },
    });
  }

  progress(progress: AgentProgress): void {
    this.record({
      kind: "progress",
      summary: `${progress.percent}% — ${progress.label}`,
      detail: progress,
    });
  }

  compact(info: CompactionInfo): void {
    this.record({
      kind: "compact",
      summary: `Dropped ${info.evicted} older tool result${info.evicted === 1 ? "" : "s"} to stay inside the context window`,
      detail: info,
    });
  }

  retry(info: ModelRetryInfo): void {
    this.record({
      kind: "retry",
      summary: `Model call retried (${info.attempt} of ${info.maxAttempts}): ${info.reason}`,
      detail: { attempt: info.attempt, maxAttempts: info.maxAttempts, delayMs: info.delayMs },
    });
  }

  stopped(userId: string): void {
    this.flushText();
    this.record({ kind: "stopped", summary: "Stopped by a Member", detail: { userId } });
  }

  /** Flush what is buffered and wait for every write to land. */
  async finish(): Promise<void> {
    this.flushText();
    this.closed = true;
    await this.chain;
  }

  private flushText(): void {
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
    const text = this.textBuffer;
    this.textBuffer = "";
    if (!text.trim()) return;
    this.trailingText += text;
    this.record({ kind: "text", summary: "", detail: { text } });
  }

  private record(event: ActivityEventInput): void {
    const ordinal = this.nextOrdinal++;
    this.chain = this.chain
      .then(async () => {
        const repo = AppDataSource.getRepository(RepositoryWorkSessionEvent);
        await repo.save(
          repo.create({
            companyId: this.scope.companyId,
            repositoryId: this.scope.repositoryId,
            sessionId: this.scope.sessionId,
            turnId: this.scope.turnId,
            ordinal,
            kind: event.kind,
            name: event.name ?? "",
            callId: event.callId ?? "",
            summary: (event.summary ?? "").slice(0, 500),
            detailJson: event.detail === undefined ? "" : safeJson(event.detail),
            isError: event.isError === true,
          }),
        );
      })
      .catch((error) => {
        // The feed is a convenience; the work must never fail because a row
        // could not be written.
        console.warn(
          `[repository-session] could not record activity for session ${this.scope.sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      });
  }
}

/** Where a new recorder's ordinals start: after everything the session has. */
export async function nextSessionEventOrdinal(sessionId: string): Promise<number> {
  const last = await AppDataSource.getRepository(RepositoryWorkSessionEvent).findOne({
    where: { sessionId },
    order: { ordinal: "DESC" },
    select: { ordinal: true, id: true },
  });
  return (last?.ordinal ?? 0) + 1;
}

/** Events after `after`, oldest first, bounded. */
export async function listSessionEvents(
  sessionId: string,
  after: number,
  limit = 500,
): Promise<RepositoryWorkSessionEvent[]> {
  const qb = AppDataSource.getRepository(RepositoryWorkSessionEvent)
    .createQueryBuilder("event")
    .where("event.sessionId = :sessionId", { sessionId })
    .andWhere("event.ordinal > :after", { after })
    .orderBy("event.ordinal", "ASC")
    .take(Math.min(Math.max(1, limit), 1000));
  return qb.getMany();
}

// ────────────────────────── one-line summaries ──────────────────────────

/**
 * The sentence a feed shows for a call, from its arguments.
 *
 * Written for the person reading the feed, not for the model: "Read
 * src/app.ts" rather than `repository_read_file {"path":"src/app.ts"}`.
 */
export function describeToolUse(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string => {
    const value = input[key];
    return typeof value === "string" ? value : "";
  };
  switch (name) {
    case "repository_read_file": {
      const offset = typeof input.offset === "number" ? input.offset : null;
      const limit = typeof input.limit === "number" ? input.limit : null;
      const range =
        offset !== null || limit !== null
          ? ` (lines ${offset ?? 1}${limit !== null ? `–${(offset ?? 1) + limit - 1}` : "+"})`
          : "";
      return `Read ${str("path")}${range}`;
    }
    case "repository_edit_file":
      return `Edited ${str("path")}`;
    case "repository_write_file":
      return `Wrote ${str("path")}`;
    case "repository_delete_file":
      return `Deleted ${str("path")}`;
    case "repository_search": {
      const scope = str("path") ? ` in ${str("path")}` : "";
      const glob = str("glob") ? ` (${str("glob")})` : "";
      return `Searched for ${shorten(str("pattern"), 80)}${scope}${glob}`;
    }
    case "repository_glob":
      return `Found files matching ${str("pattern")}${str("path") ? ` in ${str("path")}` : ""}`;
    case "repository_list_files":
      return `Listed ${str("path") || "the repository root"}`;
    case "repository_run_command":
      return `Ran ${shorten(str("command"), 120)}`;
    case "repository_commit":
      return `Committed: ${shorten(str("message").split("\n")[0] ?? "", 100)}`;
    case "repository_status":
      return "Checked the working copy status";
    case "repository_diff":
      return input.committed === true ? "Reviewed the committed diff" : "Reviewed the diff";
    case "repository_update_steps":
      return "Updated the step list";
    default:
      return `Called ${name}`;
  }
}

/** The short outcome a feed shows once a call has returned. */
export function describeToolResult(name: string, result: ToolResult): string {
  const content = result.content ?? "";
  if (result.isError) return shorten(content.split("\n")[0] ?? "Failed", 160);
  const parsed = parseJsonObject(content);
  switch (name) {
    case "repository_run_command": {
      if (parsed && parsed.ran === false) {
        return `Not run: ${shorten(String(parsed.reason ?? ""), 140)}`;
      }
      if (parsed && parsed.timedOut === true) return "Stopped at the time limit";
      if (parsed && typeof parsed.exitCode === "number") {
        return parsed.exitCode === 0 ? "Exit 0" : `Exit ${parsed.exitCode}`;
      }
      return "Finished";
    }
    case "repository_commit": {
      if (parsed && parsed.committed === false) return "Nothing to commit";
      if (parsed && typeof parsed.commit === "string") {
        const files = typeof parsed.filesChanged === "number" ? parsed.filesChanged : null;
        return `${parsed.commit.slice(0, 7)}${files !== null ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}`;
      }
      return "Committed";
    }
    case "repository_edit_file": {
      if (parsed && typeof parsed.replacements === "number") {
        return `${parsed.replacements} replacement${parsed.replacements === 1 ? "" : "s"}`;
      }
      return "Edited";
    }
    case "repository_write_file": {
      if (parsed && typeof parsed.lines === "number") return `${parsed.lines} lines written`;
      return "Written";
    }
    case "repository_read_file":
    case "repository_list_files":
    case "repository_diff":
    case "repository_status":
    case "repository_glob":
    case "repository_search": {
      const lines = content.trim() ? content.trim().split("\n").length : 0;
      if (content.startsWith("(")) return shorten(content.split("\n")[0] ?? "", 80);
      return `${lines} line${lines === 1 ? "" : "s"}`;
    }
    case "repository_update_steps":
      return "Steps updated";
    default:
      return "Done";
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === "string" ? clipText(value, INPUT_DETAIL_CHARS) : value;
  }
  return out;
}

function clipText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [${text.length - cap} more characters]`;
}

function shorten(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
