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

/** Native tools are an explicit work-surface choice; company tools keep their own Grants. */
export function openCodePermissions(
  nativeCoding: boolean,
): Record<string, "allow" | "ask" | "deny"> {
  return {
    "*": "deny",
    ...(nativeCoding
      ? Object.fromEntries(OPENCODE_NATIVE_PERMISSIONS.map((name) => [name, "ask" as const]))
      : {}),
    [`${OPENCODE_MCP}_*`]: "allow",
  };
}

export function buildOpenCodeConfig(args: {
  model: OpenCodeModel;
  effort?: ModelEffort | null;
  maxSteps: number;
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
  const modelRef = `${OPENCODE_PROVIDER}/${model.id}`;
  const outputLimit =
    model.provider === "anthropic" && /^claude-3-(opus|sonnet|haiku)-/.test(model.id) ? 4096 : 8192;
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
    enabled_providers: [OPENCODE_PROVIDER],
    model: modelRef,
    small_model: modelRef,
    default_agent: OPENCODE_AGENT,
    permission: openCodePermissions(nativeCoding),
    agent: {
      [OPENCODE_AGENT]: {
        mode: "primary",
        steps: Math.max(1, Math.floor(args.maxSteps)),
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
      [OPENCODE_PROVIDER]: {
        name: "Genosyn AI Model",
        npm:
          model.provider === "anthropic"
            ? "@ai-sdk/anthropic"
            : model.provider === "openai"
              ? "@ai-sdk/openai"
              : "@ai-sdk/openai-compatible",
        options: { apiKey: model.apiKey, ...(model.baseURL ? { baseURL: model.baseURL } : {}) },
        models: {
          [model.id]: {
            id: model.id,
            name: model.id,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: {
              // OpenCode treats zero as unknown and skips preemptive
              // compaction; keep that uncertainty in Genosyn's context gauge.
              context: model.contextWindow ?? 0,
              // OpenAI's output budget includes reasoning. Zero delegates its
              // ceiling to OpenCode instead of imposing Genosyn's text cap.
              output:
                model.provider === "openai"
                  ? 0
                  : Math.min(
                      outputLimit,
                      model.contextWindow ? Math.floor(model.contextWindow / 4) : outputLimit,
                    ),
            },
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
