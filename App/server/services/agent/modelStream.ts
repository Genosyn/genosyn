import type {
  ModelCallDetail,
  ModelCallPhase,
  ModelPulse,
  ModelPulseState,
} from "../../../shared/chatActivity.js";
import type { AgentProvider } from "./types.js";

/**
 * What an AI Model is doing while it answers, read off its own stream.
 *
 * The runtime reports the model's work in finished pieces: a tool call once its
 * arguments are complete, a reply once it has words. Between those a model can
 * work for minutes — thinking, or writing a tool call whose argument is a whole
 * document — and the only place that can tell that apart from a model that has
 * stopped is the stream itself. The OpenCode model proxy already sees every byte
 * of it, and the Codex app-server notifies on every item, so both feed a
 * {@link ModelTurnWatch}, which turns them into {@link ModelPulse}s for whoever
 * is watching and a {@link ModelCallDetail} for the turn's record once each
 * request ends.
 *
 * It keeps counts and tool names, never words: nothing read here is stored or
 * forwarded except how much was written. The reply and the thinking keep their
 * own, redacted, path to the chat.
 */

/** A pulse goes out at once when the state changes, otherwise at most this often. */
const PULSE_INTERVAL_MS = 1_000;
/** An SSE line longer than this is skipped rather than held in memory. */
const MAX_SSE_LINE_CHARS = 1_000_000;
/** A request's phases are kept up to here; the rest of its time is the last one's. */
const MAX_PHASES_PER_CALL = 32;
/** The usual characters per token, for a request whose count has not been reported yet. */
const CHARS_PER_TOKEN = 4;

export type ModelStreamSignal = {
  state?: "thinking" | "writing" | "tool_input";
  tool?: string | null;
  /** How many characters this event wrote. */
  chars?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
};

/** Split raw SSE text into its `data:` payloads, across chunk boundaries. */
export class SseDataLines {
  #buffer = "";
  #skipping = false;

  push(chunk: string): string[] {
    const out: string[] = [];
    this.#buffer += chunk;
    let start = 0;
    for (;;) {
      const newline = this.#buffer.indexOf("\n", start);
      if (newline < 0) break;
      const line = this.#buffer.slice(start, newline);
      start = newline + 1;
      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      if (line.startsWith("data:")) out.push(line.slice(5).trim());
    }
    this.#buffer = this.#buffer.slice(start);
    if (this.#buffer.length > MAX_SSE_LINE_CHARS) {
      this.#buffer = "";
      this.#skipping = true;
    }
    return out;
  }
}

/**
 * What one event on an AI Model's stream says: which state it shows, how much
 * it wrote, what it counted. Null when it says none of that — a keep-alive, a
 * bookkeeping event — which is still a sign of life.
 *
 * Each runtime speaks its provider's own wire format: Anthropic's Messages,
 * OpenAI's Responses, and Chat Completions for a custom endpoint.
 */
export function readModelStreamEvent(
  provider: AgentProvider,
  data: string,
): ModelStreamSignal | null {
  if (!data || data === "[DONE]") return null;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  const record = asRecord(event);
  if (!record) return null;
  if (provider === "anthropic") return readAnthropicEvent(record);
  if (provider === "openai") return readResponsesEvent(record);
  return readChatCompletionChunk(record);
}

function readAnthropicEvent(event: Record<string, unknown>): ModelStreamSignal | null {
  switch (event.type) {
    case "message_start": {
      const usage = asRecord(asRecord(event.message)?.usage);
      if (!usage) return null;
      return {
        // Anthropic counts cached spans apart; the prompt is all three.
        inputTokens:
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens),
        outputTokens: count(usage.output_tokens),
      };
    }
    case "content_block_start": {
      const block = asRecord(event.content_block);
      const type = typeof block?.type === "string" ? block.type : "";
      if (type === "thinking" || type === "redacted_thinking") return { state: "thinking" };
      if (type === "text") return { state: "writing" };
      if (type.endsWith("tool_use")) return { state: "tool_input", tool: toolName(block?.name) };
      return null;
    }
    case "content_block_delta": {
      const delta = asRecord(event.delta);
      switch (delta?.type) {
        case "thinking_delta":
          return { state: "thinking", chars: length(delta.thinking) };
        case "text_delta":
          return { state: "writing", chars: length(delta.text) };
        case "input_json_delta":
          return { state: "tool_input", chars: length(delta.partial_json) };
        default:
          return null;
      }
    }
    case "message_delta":
      return {
        ...(asRecord(event.usage) ? { outputTokens: count(asRecord(event.usage)?.output_tokens) } : {}),
        ...stopReason(asRecord(event.delta)?.stop_reason),
      };
    default:
      return null;
  }
}

function readResponsesEvent(event: Record<string, unknown>): ModelStreamSignal | null {
  switch (event.type) {
    case "response.output_item.added": {
      const item = asRecord(event.item);
      if (item?.type === "reasoning") return { state: "thinking" };
      if (item?.type === "message") return { state: "writing" };
      if (typeof item?.type === "string" && item.type.endsWith("_call")) {
        return { state: "tool_input", tool: toolName(item.name) ?? toolName(item.type) };
      }
      return null;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return { state: "thinking", chars: length(event.delta) };
    case "response.output_text.delta":
    case "response.refusal.delta":
      return { state: "writing", chars: length(event.delta) };
    case "response.function_call_arguments.delta":
      return { state: "tool_input", chars: length(event.delta) };
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const response = asRecord(event.response);
      const usage = asRecord(response?.usage);
      return {
        ...(usage
          ? { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) }
          : {}),
        ...stopReason(response?.status),
      };
    }
    default:
      return null;
  }
}

function readChatCompletionChunk(event: Record<string, unknown>): ModelStreamSignal | null {
  const signal: ModelStreamSignal = {};
  const usage = asRecord(event.usage);
  if (usage) {
    signal.inputTokens = count(usage.prompt_tokens);
    signal.outputTokens = count(usage.completion_tokens);
  }
  const choice = Array.isArray(event.choices) ? asRecord(event.choices[0]) : null;
  Object.assign(signal, stopReason(choice?.finish_reason));
  const delta = asRecord(choice?.delta);
  if (delta) {
    // Self-hosted servers name their reasoning field differently.
    const thought = length(delta.reasoning_content) + length(delta.reasoning) + length(delta.thinking);
    if (thought > 0) {
      signal.state = "thinking";
      signal.chars = thought;
    }
    const text = length(delta.content);
    if (text > 0) {
      signal.state = "writing";
      signal.chars = (signal.chars ?? 0) + text;
    }
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of calls) {
      const fn = asRecord(asRecord(raw)?.function);
      if (!fn) continue;
      const name = toolName(fn.name);
      if (name) signal.tool = name;
      signal.state = "tool_input";
      signal.chars = (signal.chars ?? 0) + length(fn.arguments);
    }
  }
  return Object.keys(signal).length > 0 ? signal : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function length(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function stopReason(value: unknown): { stopReason: string } | Record<string, never> {
  return typeof value === "string" && /^[\w.-]{1,40}$/.test(value) ? { stopReason: value } : {};
}

/**
 * A tool name as a model wrote it. Providers usually hold a model to the tools
 * it was offered, but not always, so it is words a model chose: only something
 * shaped like a tool name goes on.
 */
function toolName(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:-]{1,128}$/.test(value) ? value : null;
}

/** The turn is getting ready, before any request has gone out. */
export function preparingPulse(
  label: string,
  model: string | null,
  now: number = Date.now(),
): ModelPulse {
  return {
    state: "preparing",
    label,
    model,
    request: 0,
    tool: null,
    since: iso(now),
    sentAt: null,
    lastDataAt: null,
    chars: 0,
    outputTokens: 0,
    now: iso(now),
  };
}

type StreamPhase = {
  kind: ModelCallPhase["kind"];
  startedAt: number;
  endedAt: number | null;
  tool: string | null;
  chars: number;
};

export type ModelTurnWatchOptions = {
  provider: AgentProvider;
  model: string | null;
  onPulse?: (pulse: ModelPulse) => void;
  onCall?: (call: ModelCallDetail) => void;
  now?: () => number;
  pulseIntervalMs?: number;
};

/** What this turn's AI Model is doing, across all of its requests. */
export class ModelTurnWatch {
  private requests = 0;
  private current: ModelRequestWatch | null = null;
  private reportedOutputTokens = 0;
  private compactingNow = false;

  constructor(private readonly options: ModelTurnWatchOptions) {}

  get provider(): AgentProvider {
    return this.options.provider;
  }

  get clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  get pulseIntervalMs(): number {
    return this.options.pulseIntervalMs ?? PULSE_INTERVAL_MS;
  }

  get compacting(): boolean {
    return this.compactingNow;
  }

  /** The turn is getting ready, and has asked the AI Model nothing yet. */
  preparing(label: string): void {
    this.publish(preparingPulse(label, this.options.model, this.clock));
  }

  /** A request is going out. */
  begin(): ModelRequestWatch {
    this.requests += 1;
    const request = new ModelRequestWatch(this, this.requests);
    this.current = request;
    request.publish();
    return request;
  }

  /**
   * The runtime started, or finished, summarizing older parts of the
   * conversation. That is one more request to the model, and it writes words
   * nobody is shown, so it must not read as the reply being written.
   */
  setCompacting(active: boolean): void {
    if (this.compactingNow === active) return;
    this.compactingNow = active;
    this.current?.compactingChanged();
  }

  /** @internal */
  publishFrom(request: ModelRequestWatch, pulse: ModelPulse): void {
    // Only the newest request speaks for the turn.
    if (request !== this.current) return;
    this.publish(pulse);
  }

  /** @internal */
  ended(request: ModelRequestWatch, detail: ModelCallDetail | null, tokens: number): void {
    this.reportedOutputTokens += tokens;
    if (detail) {
      try {
        this.options.onCall?.(detail);
      } catch {
        // An observer never breaks a stream it is only watching.
      }
    }
    if (request === this.current) this.current = null;
  }

  /** @internal */
  outputTokens(inFlight: number): number {
    return this.reportedOutputTokens + inFlight;
  }

  /** @internal */
  modelId(): string | null {
    return this.options.model;
  }

  private publish(pulse: ModelPulse): void {
    try {
      this.options.onPulse?.(pulse);
    } catch {
      // An observer never breaks a stream it is only watching.
    }
  }
}

/** One request to the AI Model, from going out to its stream's end. */
export class ModelRequestWatch {
  private readonly lines = new SseDataLines();
  private readonly sentAt: number;
  private readonly phases: StreamPhase[] = [];
  private lastDataAt: number | null = null;
  private lastPulseAt = 0;
  private outputChars = 0;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private stop: string | null = null;
  private handedOverAt: number | null = null;
  private done = false;

  constructor(
    private readonly turn: ModelTurnWatch,
    readonly number: number,
  ) {
    this.sentAt = turn.clock;
    this.open(turn.compacting ? "compacting" : "waiting", null, this.sentAt);
  }

  /** Raw text from this request's SSE stream, as it arrives. */
  data(text: string): void {
    if (this.done || this.handedOverAt !== null) return;
    this.lastDataAt = this.turn.clock;
    for (const payload of this.lines.push(text)) {
      this.signal(readModelStreamEvent(this.turn.provider, payload), false);
    }
    this.alive();
  }

  /** A sign of life that says nothing else: bytes, a keep-alive, a notification. */
  alive(): void {
    if (this.done || this.handedOverAt !== null) return;
    const now = this.turn.clock;
    this.lastDataAt = now;
    // A model that answers has started working, before it says on what.
    if (this.state() === "waiting") this.open("thinking", null, now);
    this.maybePublish(now);
  }

  /** One thing the stream said. */
  signal(signal: ModelStreamSignal | null, touch = true): void {
    if (this.done) return;
    const now = this.turn.clock;
    if (touch) this.lastDataAt = now;
    if (!signal) {
      if (touch) this.maybePublish(now);
      return;
    }
    if (signal.inputTokens !== undefined) this.inputTokens = signal.inputTokens;
    if (signal.outputTokens !== undefined) this.outputTokens = signal.outputTokens;
    if (signal.stopReason) this.stop = signal.stopReason;
    if (this.handedOverAt !== null) return;
    let changed = false;
    if (signal.state) {
      const current = this.phases.at(-1);
      changed =
        !this.turn.compacting &&
        (current?.kind !== signal.state ||
          (signal.state === "tool_input" && Boolean(signal.tool) && current?.tool !== signal.tool));
      if (changed) this.open(signal.state, signal.tool ?? null, now, false);
    }
    if (signal.chars) {
      this.outputChars += signal.chars;
      const phase = this.phases.at(-1);
      if (phase) phase.chars += signal.chars;
    }
    if (changed) this.publish();
    else if (touch) this.maybePublish(now);
  }

  /**
   * The AI Model has finished and handed a tool call over, but its count may still
   * be on the way: Codex reports usage after the tool has started. Its time stops
   * here, and only a count can reach it now until {@link end}.
   */
  handOver(): void {
    if (this.done || this.handedOverAt !== null) return;
    const now = this.turn.clock;
    this.handedOverAt = now;
    const last = this.phases.at(-1);
    if (last) last.endedAt = now;
    this.turn.publishFrom(this, this.reading("finished", null, now, now, 0));
  }

  compactingChanged(): void {
    if (this.done || this.handedOverAt !== null) return;
    const now = this.turn.clock;
    this.open(this.turn.compacting ? "compacting" : "thinking", null, now);
  }

  /**
   * The request ended. Safe to call more than once. `answered: false` is a
   * request the AI Model refused or never reached: retries and outages report
   * those their own way, so it leaves nothing on the turn's record.
   */
  end(outcome: { answered?: boolean; stopReason?: string } = {}): void {
    if (this.done) return;
    this.done = true;
    const now = this.handedOverAt ?? this.turn.clock;
    const last = this.phases.at(-1);
    if (last && last.endedAt === null) last.endedAt = now;
    if (outcome.stopReason) this.stop = outcome.stopReason;
    const answered = outcome.answered ?? this.lastDataAt !== null;
    const tokens = this.outputTokens ?? this.estimatedTokens();
    if (this.handedOverAt === null) {
      this.turn.publishFrom(this, this.reading("finished", null, now, now, 0));
    }
    this.turn.ended(this, answered ? this.detail(now) : null, answered ? tokens : 0);
  }

  /** Publish the state as it stands. */
  publish(): void {
    const now = this.turn.clock;
    const phase = this.phases.at(-1);
    if (!phase) return;
    this.lastPulseAt = now;
    this.turn.publishFrom(
      this,
      this.reading(phase.kind, phase.tool, phase.startedAt, now, phase.chars),
    );
  }

  private state(): ModelPulseState | null {
    return this.phases.at(-1)?.kind ?? null;
  }

  private open(
    kind: ModelCallPhase["kind"],
    tool: string | null,
    now: number,
    publish = true,
  ): void {
    const previous = this.phases.at(-1);
    if (previous && this.phases.length >= MAX_PHASES_PER_CALL) {
      // A request out of room keeps its record, and still says what it is doing.
      previous.kind = kind;
      previous.tool = tool;
    } else {
      if (previous) previous.endedAt = now;
      this.phases.push({ kind, startedAt: now, endedAt: null, tool, chars: 0 });
    }
    if (publish && this.lastPulseAt > 0) this.publish();
  }

  private maybePublish(now: number): void {
    if (now - this.lastPulseAt >= this.turn.pulseIntervalMs) this.publish();
  }

  private estimatedTokens(): number {
    return Math.round(this.outputChars / CHARS_PER_TOKEN);
  }

  private reading(
    state: ModelPulseState,
    tool: string | null,
    since: number,
    now: number,
    chars: number,
  ): ModelPulse {
    return {
      state,
      label: null,
      model: this.turn.modelId(),
      request: this.number,
      tool,
      since: iso(since),
      sentAt: iso(this.sentAt),
      lastDataAt: this.lastDataAt === null ? null : iso(this.lastDataAt),
      chars,
      // The larger of the two: most providers report the count only at the end.
      outputTokens: this.turn.outputTokens(Math.max(this.outputTokens ?? 0, this.estimatedTokens())),
      now: iso(now),
    };
  }

  private detail(now: number): ModelCallDetail {
    return {
      request: this.number,
      model: this.turn.modelId(),
      sentAt: iso(this.sentAt),
      durationMs: Math.max(0, now - this.sentAt),
      phases: this.phases.map((phase) => ({
        kind: phase.kind,
        startedAt: iso(phase.startedAt),
        ms: Math.max(0, (phase.endedAt ?? now) - phase.startedAt),
        ...(phase.tool ? { tool: phase.tool } : {}),
        ...(phase.chars > 0 ? { chars: phase.chars } : {}),
      })),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      stopReason: this.stop,
    };
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
