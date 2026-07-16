/**
 * Provider-agnostic types for the in-process agent runtime.
 *
 * This is the seam that replaced the CLI harnesses. Instead of spawning
 * `claude` / `codex` / `opencode` / `goose` / `openclaw` and letting them drive
 * the tool-use loop, we talk to the model API directly (Anthropic Messages,
 * OpenAI Chat Completions, or an OpenAI-compatible custom endpoint) and run the
 * loop ourselves — handing the model the same tools a harness would: the
 * built-in coding toolset (bash + file editing) plus every MCP tool the
 * employee has (genosyn, browser, company-configured servers).
 *
 * The message + tool shapes here are a small common denominator; each model
 * client converts to/from its own wire format.
 */

/** The three brains an employee can run on now that harnesses are gone. */
export type AgentProvider = "anthropic" | "openai" | "custom";

// ---------- messages ----------

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
/** A base64 image a tool returned (e.g. a browser screenshot). */
export type ToolResultImage = { mimeType: string; data: string };
export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Images to attach to the tool result (Anthropic carries these natively). */
  images?: ToolResultImage[];
};

export type AssistantBlock = TextBlock | ToolUseBlock;
export type UserBlock = TextBlock | ToolResultBlock;

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
};

// ---------- model client ----------

export type StreamCallbacks = {
  /** Human-visible reply prose, streamed token-by-token. */
  onText?: (delta: string) => void;
  /** Fired when the model decides to call a tool (before we execute it). */
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  /** Fired after a tool returns, before the result is fed back to the model. */
  onToolResult?: (name: string, result: ToolResult) => void;
  /** Fired once per turn with what the provider says the turn cost. */
  onUsage?: (usage: TurnUsage) => void;
  /**
   * Fired when the loop dropped older tool results to keep the prompt inside
   * the model's context window. Worth surfacing: it's the difference between a
   * run that quietly forgot something and a run that behaves inexplicably.
   */
  onCompact?: (info: CompactionInfo) => void;
  /**
   * Fired when tools were dropped to fit the provider's cap. Same reasoning as
   * {@link onCompact}: an employee that silently lost a tool looks like an
   * employee that inexplicably refuses to do its job.
   */
  onToolsTrimmed?: (info: ToolTrimInfo) => void;
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
  /** How many tool results were emptied. */
  evicted: number;
  /** Roughly how many tokens that freed (our estimate, not the provider's). */
  freedTokens: number;
  /** "budget" = we saw it coming. "overflow" = the provider rejected the turn. */
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

export type AssistantTurn = {
  /** Text + tool_use blocks the model produced this turn. */
  blocks: AssistantBlock[];
  /** Provider stop reason, normalized loosely: "tool_use" when tools are pending. */
  stopReason: string;
  /** Token counts for this turn, when the provider reported them. */
  usage?: TurnUsage;
};

/**
 * One provider's client. `streamTurn` performs a single assistant turn:
 * it streams text via `onText`, collects any tool calls, and resolves with the
 * full turn. The loop ({@link ../loop}) decides whether to continue.
 */
export interface ModelClient {
  readonly model: string;
  /**
   * The most tools this provider will accept on one request, or null when it
   * doesn't publish a limit.
   *
   * Sibling of {@link AIModel.contextWindow}: a hard provider ceiling we have to
   * respect or the turn dies. OpenAI's Chat Completions rejects an over-length
   * `tools` array with a 400 that fails the whole run, and — like the context
   * window — it can't be inferred. So each client declares what it knows and
   * null means "unknown", never "unlimited": callers must treat null as no cap
   * rather than substituting a guess, because a wrong ceiling silently drops
   * tools an employee needs.
   */
  readonly maxTools: number | null;
  streamTurn(params: {
    system: string;
    messages: AgentMessage[];
    tools: ToolDef[];
    signal?: AbortSignal;
    onText?: (delta: string) => void;
    onToolUse?: (name: string) => void;
  }): Promise<AssistantTurn>;
}
