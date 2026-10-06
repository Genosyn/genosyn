import type { Config, FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import type { AIModel } from "../../db/entities/AIModel.js";
import { decryptSecret } from "../../lib/secret.js";
import { assertSafeOutboundUrl } from "../../lib/outboundUrl.js";
import { readCustomEndpoint } from "../customEndpoint.js";
import type { ModelEffort } from "../../../shared/modelEffort.js";
import type { AgentMessage } from "./types.js";

export const OPENCODE_PROVIDER = "genosyn-model";
export const OPENCODE_AGENT = "genosyn";
export const OPENCODE_MCP = "genosyn";
export function openCodeProviderId(provider?: OpenCodeModel["provider"]): string {
  // Preserve OpenCode's own OpenAI catalog, including each model's actual
  // output ceiling. A custom alias would discard those capabilities.
  return provider === "openai" ? "openai" : OPENCODE_PROVIDER;
}
export const OPENCODE_NATIVE_PERMISSIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "external_directory",
  "lsp",
  "todowrite",
];

/**
 * Response ceiling for a custom endpoint whose context window is known. Open
 * reasoning models think before every tool call, and a hard step on a 27B
 * model can spend well over 8K tokens doing so; a response cut off at the
 * ceiling ends the turn with nothing done. A quarter of the window still
 * bounds it, so the prompt keeps most of the context. An unknown window keeps
 * the old 8K, since a server with a small window rejects a larger request.
 */
export const CUSTOM_MODEL_OUTPUT_LIMIT = 32_768;

/**
 * How long a custom endpoint may take to start answering, and between the
 * parts of an answer. OpenCode and Node's fetch both give up after five
 * minutes, and OpenCode then sends the request again from the start. A busy
 * self-hosted server queues requests and reads a long conversation at a few
 * thousand tokens a second, so it can need longer than that: on 2026-10-02 a
 * saturated vLLM took over five minutes to answer Routine steps, and each
 * retry threw away the prompt it had nearly read and queued it again. A server
 * that has stopped is still caught, by the outage hold in `opencodeProxy.ts`
 * or by the Run's time limit.
 */
export const SELF_HOSTED_RESPONSE_WAIT_MS = 15 * 60_000;

export type OpenCodeModel = {
  id: string;
  provider: "anthropic" | "openai" | "custom";
  apiKey: string;
  baseURL?: string;
  contextWindow: number | null;
};

/** Credentials come from the AI Model row, never the host's provider profiles. */
export async function resolveOpenCodeModel(model: AIModel): Promise<OpenCodeModel> {
  if (model.authMode === "subscription") {
    throw new Error("OpenAI subscription AI Models use the official Codex runtime.");
  }
  if (model.provider === "custom") {
    const cfg = readCustomEndpoint(model);
    if (!cfg) throw new Error("Custom endpoint is not fully configured. Re-enter its base URL.");
    await assertSafeOutboundUrl(cfg.baseURL);
    return {
      id: cfg.modelId,
      provider: "custom",
      apiKey: cfg.apiKey ?? "",
      baseURL: cfg.baseURL.trim().replace(/\/+$/, ""),
      contextWindow: model.contextWindow,
    };
  }
  if (model.authMode !== "apikey") throw new Error("This AI Model requires an API key.");
  let encrypted: unknown;
  try {
    encrypted = (JSON.parse(model.configJson || "{}") as Record<string, unknown>).apiKeyEncrypted;
  } catch {
    encrypted = null;
  }
  if (typeof encrypted !== "string" || !encrypted)
    throw new Error("No API key is set for this AI Model.");
  let apiKey: string;
  try {
    apiKey = decryptSecret(encrypted);
  } catch {
    throw new Error("The stored AI Model API key could not be decrypted.");
  }
  return { id: model.model, provider: model.provider, apiKey, contextWindow: model.contextWindow };
}

/**
 * OpenCode answers a malformed or unknown tool call by rewriting it to this
 * internal tool, whose only effect is to tell the model what was wrong. It is
 * never offered to the model as a callable tool, but OpenCode removes any tool
 * whose last matching rule is `"*": "deny"` — so without its own rule, every
 * repair failed with "Model tried to call unavailable tool 'invalid'" and the
 * model never learned which name or argument it got wrong.
 */
export const OPENCODE_REPAIR_TOOL = "invalid";

/**
 * OpenCode's guard against a model repeating itself: three identical tool calls
 * in a row within one reply ask this permission. Under `"*": "deny"` the guard
 * denied it outright, and a denial there fails the whole turn. A Daily Partner
 * Prospecting Run asked for five partnership records at once by an unlisted
 * tool name; OpenCode repaired each into the same `invalid` call, and the Run
 * ended after 52 minutes of work. Allowed, the calls run and answer as they
 * would have, which tells the model what to change; a Run's time limit still
 * ends a model that never does.
 */
export const OPENCODE_REPEAT_GUARD = "doom_loop";

/** Native tools are an explicit work-surface choice; company tools keep their own Grants. */
export function openCodePermissions(
  nativeCoding: boolean,
): Record<string, "allow" | "ask" | "deny"> {
  return {
    "*": "deny",
    [OPENCODE_REPAIR_TOOL]: "allow",
    [OPENCODE_REPEAT_GUARD]: "allow",
    ...(nativeCoding
      ? Object.fromEntries(OPENCODE_NATIVE_PERMISSIONS.map((name) => [name, "ask" as const]))
      : {}),
    [`${OPENCODE_MCP}_*`]: "allow",
  };
}

export function buildOpenCodeConfig(args: {
  model: OpenCodeModel;
  effort?: ModelEffort | null;
  maxSteps: number | null;
  nativeCoding: boolean;
  mcp: { url: string; token: string };
}): Config {
  const { model, effort, nativeCoding } = args;
  if (effort === "ultra")
    throw new Error("Ultra effort requires a supported ChatGPT subscription AI Model.");
  if (model.provider === "custom" && effort != null)
    throw new Error("Custom AI Models use their default effort.");
  if (model.provider === "anthropic" && (effort === "none" || effort === "minimal")) {
    throw new Error("The selected effort is not supported by this Anthropic AI Model.");
  }
  const providerId = openCodeProviderId(model.provider);
  const modelRef = `${providerId}/${model.id}`;
  const outputLimit =
    model.provider === "anthropic" && /^claude-3-(opus|sonnet|haiku)-/.test(model.id)
      ? 4096
      : model.provider === "custom" && model.contextWindow
        ? CUSTOM_MODEL_OUTPUT_LIMIT
        : 8192;
  const options =
    model.provider === "openai"
      ? { store: false, ...(effort ? { reasoningEffort: effort } : {}) }
      : model.provider === "anthropic" && effort
        ? { effort }
        : {};
  return {
    logLevel: "ERROR",
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    plugin: [],
    instructions: [],
    skills: { paths: [], urls: [] },
    watcher: { ignore: ["**/*"] },
    formatter: false,
    lsp: nativeCoding,
    enabled_providers: [providerId],
    model: modelRef,
    small_model: modelRef,
    default_agent: OPENCODE_AGENT,
    permission: openCodePermissions(nativeCoding),
    agent: {
      [OPENCODE_AGENT]: {
        mode: "primary",
        // OpenCode natively leaves iterations unlimited when steps is absent.
        ...(args.maxSteps === null ? {} : { steps: Math.max(1, Math.floor(args.maxSteps)) }),
        prompt:
          "You are the runtime for a Genosyn AI Employee. Follow the supplied Genosyn system instructions and current request. Use only the tools exposed for this work surface.",
      },
      build: { disable: true },
      plan: { disable: true },
      general: { disable: true },
      explore: { disable: true },
      title: { disable: true },
      summary: { disable: true },
    },
    provider: {
      [providerId]: {
        name: "Genosyn AI Model",
        npm:
          model.provider === "anthropic"
            ? "@ai-sdk/anthropic"
            : model.provider === "openai"
              ? "@ai-sdk/openai"
              : "@ai-sdk/openai-compatible",
        options: {
          apiKey: model.apiKey,
          ...(model.baseURL ? { baseURL: model.baseURL } : {}),
          ...(model.provider === "custom"
            ? {
                headerTimeout: SELF_HOSTED_RESPONSE_WAIT_MS,
                chunkTimeout: SELF_HOSTED_RESPONSE_WAIT_MS,
              }
            : {}),
        },
        models: {
          [model.id]: {
            id: model.id,
            name: model.id,
            status: "active",
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            ...(model.provider === "openai"
              ? {}
              : {
                  limit: {
                    // OpenCode treats zero as unknown and skips preemptive
                    // compaction; keep that uncertainty in Genosyn's context gauge.
                    context: model.contextWindow ?? 0,
                    output: Math.min(
                      outputLimit,
                      model.contextWindow ? Math.floor(model.contextWindow / 4) : outputLimit,
                    ),
                  },
                }),
            options,
          },
        },
      },
    },
    mcp: {
      [OPENCODE_MCP]: {
        type: "remote",
        url: args.mcp.url,
        headers: { Authorization: `Bearer ${args.mcp.token}` },
        oauth: false,
        enabled: true,
        timeout: 10 * 60 * 1000,
      },
    },
    compaction: { auto: true, prune: true },
    experimental: { openTelemetry: false },
  };
}

/**
 * A fresh external session receives the DB conversation as labelled history.
 * Images remain image parts rather than becoming opaque base64 inside prose.
 * Historical tool calls are records, never replayed actions.
 */
export function openCodePromptParts(
  messages: AgentMessage[],
): Array<TextPartInput | FilePartInput> {
  const parts: Array<TextPartInput | FilePartInput> = [];
  messages.forEach((message, index) => {
    const current = index === messages.length - 1;
    parts.push({
      type: "text",
      text: current ? "Current request:" : `Conversation history — ${message.role}:`,
    });
    for (const block of message.content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "tool_use")
        parts.push({
          type: "text",
          text: `Recorded tool call ${block.name}: ${JSON.stringify(block.input)}`,
        });
      else if (block.type === "tool_result") {
        parts.push({
          type: "text",
          text: `Recorded tool result ${block.toolUseId}${block.isError ? " (failed)" : ""}: ${block.content}`,
        });
        for (const img of block.images ?? [])
          parts.push({
            type: "file",
            mime: img.mimeType,
            url: `data:${img.mimeType};base64,${img.data}`,
            filename: img.sourceLabel,
          });
      } else {
        parts.push({
          type: "file",
          mime: block.mimeType,
          url: `data:${block.mimeType};base64,${block.data}`,
          filename: block.sourceLabel,
        });
      }
    }
  });
  return parts;
}
