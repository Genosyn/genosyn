/** Common messages, tools, and activity callbacks shared by the OpenCode and Codex adapters. */

import type { ContextUsage } from "./contextUsage.js";

export type { ContextUsage } from "./contextUsage.js";

/** Supported AI Model services. */
export type AgentProvider = "anthropic" | "openai" | "custom";

// ---------- messages ----------

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
/** A base64 image supplied by a Member or returned by a tool. */
export type ToolResultImage = {
  mimeType: string;
  data: string;
  /** Attachment identity shown directly beside an uploaded image. */
  sourceLabel?: string;
};
export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Images to attach to the tool result (Anthropic carries these natively). */
  images?: ToolResultImage[];
};

export type AssistantBlock = TextBlock | ToolUseBlock;
export type ImageBlock = { type: "image" } & ToolResultImage;
export type UserBlock = TextBlock | ImageBlock | ToolResultBlock;

export type AgentMessage =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

// ---------- tools ----------

/** A JSON-Schema object describing a tool's arguments. */
export type ToolInputSchema = Record<string, unknown>;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
  /** Base64 images the tool produced (e.g. browser screenshots). */
  images?: ToolResultImage[];
};

/** A tool the model can call. `run` executes it and returns text for the model. */
export type AgentTool = ToolDef & {
  run(input: Record<string, unknown>): Promise<ToolResult>;
  /**
   * The tool observes state and never changes it — a file read, a search, a
   * listing, a diff.
   *
   * Exposed as an MCP annotation. Genosyn serializes its registry calls to
   * preserve company write ordering; OpenCode owns native-tool scheduling.
   * Unset means "assume it writes".
   */
  readOnly?: boolean;
  /**
   * What this call *really* is, for logs and the run transcript.
   *
   * Only dispatching tools implement it. `call_tool` runs every deferred tool
   * in the catalogue, so without this every one of them would appear in the
   * transcript as `call_tool` — turning the most useful column in a run log
   * into a constant. Returning `{name, input}` lets the adapter report the target
   * the model actually reached for.
   */
  describeCall?(input: Record<string, unknown>): {
    name: string;
    input: Record<string, unknown>;
  };
};

// ---------- runtime activity ----------

export type StreamCallbacks = {
  /** Human-visible reply prose, streamed token-by-token. */
  onText?: (delta: string) => void;
  /** Ephemeral direct-chat progress, explicitly reported by the employee. */
  onProgress?: (progress: AgentProgress) => void;
  /** Fired before retrying a transient model-service or transport failure. */
  onModelRetry?: (info: ModelRetryInfo) => void;
  /**
   * Fired when the model decides to call a tool (before we execute it).
   *
   * `callId` identifies this call within the turn, so recorded activity can
   * pair it with {@link onToolResult} even when the runtime reports concurrent
   * native calls out of order.
   */
  onToolUse?: (name: string, input: Record<string, unknown>, callId?: string) => void;
  /** Fired after a tool returns, before the result is fed back to the model. */
  onToolResult?: (name: string, result: ToolResult, callId?: string) => void;
  /** Fired once per turn with what the provider says the turn cost. */
  onUsage?: (usage: TurnUsage) => void;
  /**
   * Fired once per turn with how full the model's context window now is —
   * {@link onUsage}'s prompt count divided by `AIModel.contextWindow`.
   *
   * Separate from {@link onUsage} rather than derived at each consumer because
   * the two have different audiences: `onUsage` is a cost line for the Run
   * transcript, this is a human-facing gauge. Keeping it its own callback also
   * lets the delegation seam forward one and withhold the other — a delegated
   * worker runs its own short conversation, so its prompt size says nothing
   * about how full the Member's chat is.
   */
  onContextUsage?: (usage: ContextUsage) => void;
  /**
   * Fired when the external runtime compacts the conversation to fit the
   * model's context window. Counts remain null when it does not report them.
   */
  onCompact?: (info: CompactionInfo) => void;
  /**
   * Fired when tools were dropped to fit the provider's cap. Same reasoning as
   * {@link onCompact}: an employee that silently lost a tool looks like an
   * employee that inexplicably refuses to do its job.
   */
  onToolsTrimmed?: (info: ToolTrimInfo) => void;
  /**
   * Fired once per run with how the tool catalogue was split into the working
   * set the model is shown and the tail it has to discover.
   *
   * Same reasoning as {@link onCompact} and {@link onToolsTrimmed}: deferral is
   * invisible from the outside, and "the employee never used the tool" and "the
   * employee was never shown the tool" look identical in a transcript unless
   * something says which happened.
   */
  onToolsDeferred?: (info: ToolDeferralInfo) => void;
};

export type AgentProgress = {
  /** Honest completed-work estimate. The final reply owns 100%. */
  percent: number;
  /** Short description of the activity happening now. */
  label: string;
};

/** How the run's tools were split between the working set and the catalogue. */
export type ToolDeferralInfo = {
  /** Tools sent on every request this run. */
  resident: number;
  /** Tools reachable only via `find_tools` / `call_tool`. */
  deferred: number;
  /** Domains represented in the deferred catalogue, for the run log. */
  domains: string[];
  /** Names made resident because a Skill's declared toolset asked for them. */
  fromSkills: string[];
};

/** What the tool trim dropped, and what forced it. */
export type ToolTrimInfo = {
  /** How many tools the employee had before trimming. */
  offered: number;
  /** The provider's ceiling we trimmed to. */
  limit: number;
  /** Model-facing names of the tools that were dropped. */
  dropped: string[];
};

/** What one round of compaction did, and what forced it. */
export type CompactionInfo = {
  /** How many tool results were emptied, or null when not reported. */
  evicted: number | null;
  /** Runtime-reported estimate of freed tokens, or null when not reported. */
  freedTokens: number | null;
  /** "budget" = proactive compaction. "overflow" = provider context rejection. */
  reason: "budget" | "overflow";
};

/**
 * What a turn actually cost, as counted by the provider's own tokenizer.
 *
 * This is the only trustworthy measure of how full the context is: model ids are
 * free text and a custom endpoint can serve any weights, so we can't know the
 * tokenizer and any local estimate would be a guess.
 *
 * `inputTokens` is the whole prompt the provider billed for — on Anthropic that
 * means summing the cached spans back in, since `input_tokens` there counts only
 * the uncached remainder.
 */
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
};

/** One transparent retry of the current model turn. */
export type ModelRetryInfo = {
  /** The provider call about to start, counting the original as attempt 1. */
  attempt: number;
  /** Total provider calls allowed, or null when the runtime does not report it. */
  maxAttempts: number | null;
  /** Backoff before the next provider call. */
  delayMs: number;
  /** Safe summary such as `HTTP 500`; never the provider response body. */
  reason: string;
};
