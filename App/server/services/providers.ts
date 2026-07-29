import type { AIModel, Provider } from "../db/entities/AIModel.js";

/**
 * Per-provider facts for the model backends an employee can run. API-key and
 * custom-endpoint models are called directly in-process. OpenAI additionally
 * supports the official Codex app-server subscription runtime on trusted
 * self-hosted installs; this narrow integration is not a return to arbitrary
 * provider CLI harnesses.
 *
 *   - anthropic → Anthropic Messages API (Claude), API key
 *   - openai    → OpenAI Chat Completions API (GPT), API key
 *   - custom    → any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp,
 *                 LM Studio, a gateway), base URL + model id + optional key
 */
export type ProviderSpec = {
  /** Human label shown in the UI. */
  label: string;
  /** Default model id seeded when the user first picks this provider. */
  defaultModel: string;
  /** Env var the provider's own tooling conventionally reads — informational. */
  apiKeyEnv: string | null;
  /** Does this provider connect with a plain API key? */
  supportsApiKey: boolean;
  /** Does this provider have a sanctioned consumer-subscription runtime? */
  supportsSubscription: boolean;
  /** Does this provider connect via a custom OpenAI-compatible endpoint? */
  supportsCustomEndpoint: boolean;
};

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    supportsSubscription: false,
    supportsCustomEndpoint: false,
  },
  openai: {
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
    supportsApiKey: true,
    supportsSubscription: true,
    supportsCustomEndpoint: false,
  },
  custom: {
    label: "Custom OpenAI-compatible endpoint",
    defaultModel: "",
    apiKeyEnv: null,
    supportsApiKey: false,
    supportsSubscription: false,
    supportsCustomEndpoint: true,
  },
};

/**
 * A Model is "connected" if a usable credential is present:
 *  - apikey:         an encrypted API key is on file
 *  - subscription:   an encrypted managed ChatGPT session or supported
 *                    Codex access token is on file
 *  - customEndpoint: an encrypted base URL is on file (the key is optional —
 *                    most local servers don't enforce one)
 */
export function isModelConnected(m: AIModel): boolean {
  let cfg: Record<string, unknown> = {};
  try {
    const v = JSON.parse(m.configJson || "{}");
    if (v && typeof v === "object") cfg = v as Record<string, unknown>;
  } catch {
    return false;
  }
  if (m.authMode === "apikey") {
    return (
      typeof cfg.apiKeyEncrypted === "string" && (cfg.apiKeyEncrypted as string).trim().length > 0
    );
  }
  if (m.authMode === "subscription") {
    return (
      (typeof cfg.codexAuthEncrypted === "string" &&
        (cfg.codexAuthEncrypted as string).trim().length > 0) ||
      (typeof cfg.codexAccessTokenEncrypted === "string" &&
        (cfg.codexAccessTokenEncrypted as string).trim().length > 0)
    );
  }
  if (m.authMode === "customEndpoint") {
    return (
      typeof cfg.baseURLEncrypted === "string" && (cfg.baseURLEncrypted as string).trim().length > 0
    );
  }
  return false;
}
