import type { ModelEffort } from "../../shared/modelEffort.js";
import type { AIModel } from "../db/entities/AIModel.js";
import type { AIModelKeyHealth } from "../db/entities/AIModelKeyHealth.js";
import { canProbeContextWindow } from "./agent/contextWindow.js";
import { codingRuntimeAvailability } from "./agent/codingAvailability.js";
import { subscriptionCredentialKind, subscriptionUnavailableReason } from "./codexSubscription.js";
import { publicApiKeys, type PublicApiKey } from "./modelApiKeys.js";
import { modelEffortLevels } from "./modelEffort.js";
import { keyRestingUntil, listKeyHealth } from "./modelKeyHealth.js";
import { modelRunCapacity } from "./modelRunCapacity.js";
import type { ModelUser } from "./models.js";
import { PROVIDERS, isModelConnected } from "./providers.js";

/**
 * An AI Model as the API shows it: what it is, whether it is connected, its
 * settings, and who uses it — never a credential. Keys appear only as masked
 * previews with their health, a custom endpoint only as its host, and a
 * ChatGPT sign-in only as which kind of credential is on file.
 */
export type PublicModel = {
  id: string;
  companyId: string;
  provider: "anthropic" | "openai" | "custom";
  model: string;
  authMode: "apikey" | "subscription" | "customEndpoint";
  /**
   * In an AI Employee's list: whether this is the model its Routines and chat
   * use. Always false in the company's list, where a model is active for some
   * employees and not others — see `employees`.
   */
  isActive: boolean;
  /** When the model was added to the company. */
  createdAt: string;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  /**
   * An API-key model's keys — the pool its sessions are spread across, in the
   * order they are stored — each as a masked preview with its health and the
   * sessions it carried in the last day. Empty for subscription and
   * custom-endpoint models.
   */
  apiKeys: PublicApiKey[];
  /** Env var the provider conventionally reads (informational), or null. */
  apiKeyEnv: string | null;
  /** Does this provider connect with a plain API key? */
  supportsApiKey: boolean;
  /** Does this provider support the official consumer-subscription runtime? */
  supportsSubscription: boolean;
  /** Is subscription auth allowed by this install's security mode? */
  subscriptionAvailable: boolean;
  subscriptionUnavailableReason: string | null;
  /** Which encrypted subscription credential is present, without its value. */
  subscriptionCredentialKind: "chatgptSession" | "accessToken" | null;
  /** Whether subscription turns may safely receive the bash coding tool. */
  subscriptionShellAvailable: boolean;
  /** Does this provider connect via a custom OpenAI-compatible endpoint? */
  supportsCustomEndpoint: boolean;
  /** Host-only preview of the configured base URL — `null` when unset. */
  customEndpointHost: string | null;
  /** The raw model id stored on configJson — `null` when unset. */
  customEndpointModelId: string | null;
  /** True if a custom-endpoint API key is on file (we never echo the plaintext). */
  customEndpointHasApiKey: boolean;
  /**
   * Context window in tokens as reported by the provider, or null when it
   * doesn't say (OpenAI) or we couldn't reach it. Null means unknown.
   */
  contextWindow: number | null;
  /** Whether the window above was probed or typed in. Null when unknown. */
  contextWindowSource: "probed" | "manual" | null;
  /** Can we ask this provider for the window at all? Drives the UI's affordances. */
  contextWindowProbeable: boolean;
  /**
   * Efforts this model accepts beyond its default, lowest first. Empty for a
   * custom endpoint or a model without known effort support, which always
   * runs at its default.
   */
  effortLevels: ModelEffort[];
  /** Stored concurrent-Run setting: null is the default, 0 is no limit. */
  maxConcurrentRuns: number | null;
  /** The limit Routine Runs actually get, across every employee on it; null means no limit. */
  effectiveMaxConcurrentRuns: number | null;
  /** Why that limit applies: an explicit setting, a default for its kind, or none. */
  concurrencySource: "configured" | "local-default" | "subscription-default" | "unlimited";
  /** Every AI Employee this model is attached to, by name, and whether it is their active one. */
  employees: ModelUser[];
  /**
   * Other company AI Models that are exactly this one — same service, model,
   * endpoint and keys — and could be merged into it. Only the company's list
   * fills it; elsewhere it is empty.
   */
  duplicateIds: string[];
};

function safeParseConfig(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "Anthropic (Claude) · claude-opus-5-5" — how the audit log names a model. */
export function describeModelForAudit(m: Pick<AIModel, "provider" | "model">): string {
  return `${PROVIDERS[m.provider]?.label ?? m.provider} · ${m.model}`;
}

/** Shape one model for the wire. */
export function toPublicModel(
  m: AIModel,
  options: {
    isActive?: boolean;
    health?: readonly AIModelKeyHealth[];
    employees?: readonly ModelUser[];
    duplicateIds?: readonly string[];
  } = {},
): PublicModel {
  const cfg = safeParseConfig(m.configJson);
  const apiKeyEncrypted =
    typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  const customEndpointHost =
    typeof cfg.baseURLPreview === "string" ? (cfg.baseURLPreview as string) : null;
  const customEndpointModelId = typeof cfg.modelId === "string" ? (cfg.modelId as string) : null;
  const spec = PROVIDERS[m.provider];
  const connected = isModelConnected(m);
  const unavailable = spec.supportsSubscription ? subscriptionUnavailableReason() : null;
  const capacity = modelRunCapacity(m);
  return {
    id: m.id,
    companyId: m.companyId,
    provider: m.provider,
    model: m.model,
    authMode: m.authMode,
    isActive: options.isActive ?? false,
    createdAt: (m.createdAt ?? new Date()).toISOString(),
    connectedAt: m.connectedAt?.toISOString() ?? null,
    status: connected ? "connected" : "not_connected",
    apiKeyMasked: apiKeyEncrypted ? "sk-…••••" : null,
    apiKeys: publicApiKeys(m, options.health ?? [], {
      restingUntil: (keyId) => keyRestingUntil(m.id, keyId),
    }),
    apiKeyEnv: spec.apiKeyEnv,
    supportsApiKey: spec.supportsApiKey,
    supportsSubscription: spec.supportsSubscription,
    subscriptionAvailable: spec.supportsSubscription && unavailable === null,
    subscriptionUnavailableReason: unavailable,
    subscriptionCredentialKind: subscriptionCredentialKind(m),
    subscriptionShellAvailable:
      spec.supportsSubscription && unavailable === null && codingRuntimeAvailability().available,
    supportsCustomEndpoint: spec.supportsCustomEndpoint,
    customEndpointHost,
    customEndpointModelId,
    customEndpointHasApiKey: m.authMode === "customEndpoint" && Boolean(apiKeyEncrypted),
    contextWindow: m.contextWindow ?? null,
    contextWindowSource: m.contextWindowSource ?? null,
    contextWindowProbeable: canProbeContextWindow(m),
    effortLevels: modelEffortLevels(m),
    maxConcurrentRuns: m.maxConcurrentRuns ?? null,
    effectiveMaxConcurrentRuns: capacity.limit,
    concurrencySource: capacity.source,
    employees: [...(options.employees ?? [])],
    duplicateIds: [...(options.duplicateIds ?? [])],
  };
}

/** Each model's key health, by model id. */
export async function healthByModel(
  models: readonly Pick<AIModel, "id">[],
): Promise<Map<string, AIModelKeyHealth[]>> {
  const byModel = new Map<string, AIModelKeyHealth[]>();
  for (const row of await listKeyHealth(models.map((m) => m.id))) {
    const rows = byModel.get(row.modelId);
    if (rows) rows.push(row);
    else byModel.set(row.modelId, [row]);
  }
  return byModel;
}
