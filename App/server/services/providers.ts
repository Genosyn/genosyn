import type { AIModel, Provider } from "../db/entities/AIModel.js";

/**
 * Per-provider facts for the three model APIs an employee can run on now that
 * the CLI harnesses are gone. There is no CLI to install, no subscription to
 * sign into, and no on-disk credential dir — a provider is just an API we call
 * in-process, and its "spec" is the handful of facts the UI and the credential
 * resolver need.
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
  /** Does this provider connect via a custom OpenAI-compatible endpoint? */
  supportsCustomEndpoint: boolean;
};

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    supportsCustomEndpoint: false,
  },
  openai: {
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
    supportsApiKey: true,
    supportsCustomEndpoint: false,
  },
  custom: {
    label: "Custom OpenAI-compatible endpoint",
    defaultModel: "",
    apiKeyEnv: null,
    supportsApiKey: false,
    supportsCustomEndpoint: true,
  },
};

/**
 * A Model is "connected" if a usable credential is present:
 *  - apikey:         an encrypted API key is on file
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
    return typeof cfg.apiKeyEncrypted === "string" && (cfg.apiKeyEncrypted as string).length > 0;
  }
  if (m.authMode === "customEndpoint") {
    return typeof cfg.baseURLEncrypted === "string" && (cfg.baseURLEncrypted as string).length > 0;
  }
  return false;
}
