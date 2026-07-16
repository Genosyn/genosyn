import type { AIModel } from "../../../db/entities/AIModel.js";
import { decryptSecret } from "../../../lib/secret.js";
import { readCustomEndpoint } from "../../customEndpoint.js";
import type { ModelClient } from "../types.js";
import { createAnthropicClient } from "./anthropic.js";
import { createOpenAIClient, OPENAI_MAX_TOOLS } from "./openai.js";

/**
 * Resolve an {@link AIModel} row into a live {@link ModelClient}, decrypting
 * whatever credential the row carries. Returns a discriminated result rather
 * than throwing so the seams can surface a friendly "not connected" message.
 *
 *  - anthropic + apikey       → Anthropic Messages API with the stored key
 *  - openai    + apikey       → OpenAI Chat Completions with the stored key
 *  - custom    + customEndpoint → OpenAI-compatible client at the stored baseURL
 */
export function createModelClient(
  model: AIModel,
): { client: ModelClient } | { error: string } {
  if (model.authMode === "customEndpoint") {
    if (model.provider !== "custom") {
      return { error: `${model.provider} does not use a custom endpoint — use an API key.` };
    }
    const cfg = readCustomEndpoint(model);
    if (!cfg) {
      return {
        error:
          "Custom endpoint isn't fully configured. Open the model settings and re-enter the base URL.",
      };
    }
    return {
      client: createOpenAIClient({
        apiKey: cfg.apiKey ?? "",
        model: cfg.modelId,
        baseURL: normalizeBaseURL(cfg.baseURL),
        // A custom endpoint only borrows OpenAI's wire format, not its limits:
        // whatever vLLM/Ollama/gateway is behind this URL sets its own, and we
        // have no way to ask. Unknown, so no cap.
        maxTools: null,
      }),
    };
  }

  // apikey mode — anthropic or openai.
  const key = decryptApiKey(model);
  if ("error" in key) return { error: key.error };

  if (model.provider === "anthropic") {
    return { client: createAnthropicClient({ apiKey: key.apiKey, model: model.model }) };
  }
  if (model.provider === "openai") {
    return {
      client: createOpenAIClient({
        apiKey: key.apiKey,
        model: model.model,
        maxTools: OPENAI_MAX_TOOLS,
      }),
    };
  }
  return { error: `${model.provider} requires a custom endpoint, not an API key.` };
}

function decryptApiKey(model: AIModel): { apiKey: string } | { error: string } {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(model.configJson || "{}");
  } catch {
    cfg = {};
  }
  const enc = typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  if (!enc) return { error: "No API key is set for this employee." };
  try {
    return { apiKey: decryptSecret(enc) };
  } catch {
    return { error: "Stored API key could not be decrypted (sessionSecret may have rotated)." };
  }
}

/**
 * OpenAI-compatible SDKs expect the base URL to point at the API root (the part
 * before `/chat/completions`). Users typically paste either the root or a
 * `.../v1` URL; both are fine. We just strip a trailing slash so the SDK's own
 * path join doesn't double up.
 */
export function normalizeBaseURL(s: string): string {
  return s.trim().replace(/\/+$/, "");
}
