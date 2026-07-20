import type { AIModel } from "../../db/entities/AIModel.js";
import { PROVIDERS } from "../providers.js";

/**
 * Turn a provider SDK error into a safe, actionable message for chat and Run
 * logs. Both OpenAI and Anthropic expose roughly the same useful metadata, but
 * through different error classes; reading the small shared shape keeps this
 * formatter independent of either SDK.
 */
export function formatModelError(model: AIModel, error: unknown): string {
  const meta = errorMetadata(error);
  const category = classifyError(meta);
  const modelLabel = `${PROVIDERS[model.provider].label} · ${oneLine(model.model, 160)}`;
  const endpoint = endpointLabel(model);
  const lines = [heading(category), "", `Model: ${modelLabel}`];

  if (endpoint) lines.push(`Endpoint: ${endpoint}`);
  lines.push(`Details: ${meta.message}`);
  if (meta.status !== null && !meta.message.startsWith(String(meta.status))) {
    lines.push(`HTTP status: ${meta.status}`);
  }
  if (meta.code && !meta.message.toLowerCase().includes(meta.code.toLowerCase())) {
    lines.push(`Code: ${meta.code}`);
  }
  if (meta.requestId) lines.push(`Request ID: ${meta.requestId}`);

  lines.push("", "What to check:", ...guidance(category, model.provider));
  lines.push("", "Open Settings → Model for this employee, then retry.");
  return lines.join("\n");
}

type ErrorCategory =
  | "network"
  | "timeout"
  | "authentication"
  | "rate_limit"
  | "not_found"
  | "context"
  | "provider"
  | "request";

type ErrorMetadata = {
  message: string;
  name: string;
  status: number | null;
  code: string | null;
  requestId: string | null;
};

function errorMetadata(error: unknown): ErrorMetadata {
  const record = asRecord(error);
  const status = numberField(record, "status") ?? numberField(record, "statusCode");
  const code =
    stringField(record, "code") ??
    stringField(asRecord(record?.error), "code") ??
    stringInCauseChain(record, "code");
  const requestId =
    stringField(record, "requestID") ??
    stringField(record, "requestId") ??
    stringField(record, "request_id");

  return {
    message: oneLine(stringField(record, "message") ?? String(error), 1_000),
    name: oneLine(stringField(record, "name") ?? "", 100),
    status,
    code: code ? oneLine(code, 120) : null,
    requestId: requestId ? oneLine(requestId, 200) : null,
  };
}

/** Node's fetch errors commonly nest the useful ECONNREFUSED/ENOTFOUND code. */
function stringInCauseChain(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  let current = asRecord(record?.cause);
  for (let depth = 0; current && depth < 4; depth += 1) {
    const found = stringField(current, key);
    if (found) return found;
    current = asRecord(current.cause);
  }
  return null;
}

function classifyError(meta: ErrorMetadata): ErrorCategory {
  const haystack = `${meta.name} ${meta.message} ${meta.code ?? ""}`.toLowerCase();

  if (
    meta.status === 401 ||
    meta.status === 403 ||
    /authentication|unauthori[sz]ed|permission denied|invalid api key/.test(haystack)
  ) {
    return "authentication";
  }
  if (meta.status === 429 || /rate.?limit|quota|too many requests/.test(haystack)) {
    return "rate_limit";
  }
  if (
    /context.{0,20}(length|window|limit)|maximum context|too many tokens|prompt is too long/.test(
      haystack,
    )
  ) {
    return "context";
  }
  if (
    meta.status === 408 ||
    meta.status === 504 ||
    /timed? ?out|timeout|aborted|aborterror/.test(haystack)
  ) {
    return "timeout";
  }
  if (
    !meta.status &&
    /network|connection error|apiconnection|fetch failed|econn|enotfound|eai_again|dns|socket|tls|certificate/.test(
      haystack,
    )
  ) {
    return "network";
  }
  if (meta.status === 404 || /model.{0,20}not found|unknown model/.test(haystack)) {
    return "not_found";
  }
  if (meta.status !== null && meta.status >= 500) return "provider";
  return "request";
}

function heading(category: ErrorCategory): string {
  switch (category) {
    case "network":
      return "Couldn’t reach the active AI Model.";
    case "timeout":
      return "The active AI Model did not respond in time.";
    case "authentication":
      return "The active AI Model rejected its credentials.";
    case "rate_limit":
      return "The active AI Model is rate-limited or out of quota.";
    case "not_found":
      return "The configured AI Model or endpoint was not found.";
    case "context":
      return "The active AI Model rejected an over-long prompt.";
    case "provider":
      return "The active AI Model service failed this request.";
    case "request":
      return "The active AI Model rejected this request.";
  }
}

function guidance(category: ErrorCategory, provider: AIModel["provider"]): string[] {
  if (category === "network") {
    return provider === "custom"
      ? [
          "• Confirm the model server is running and reachable from the Genosyn container or host.",
          "• In Docker, use host.docker.internal instead of localhost for a model server running on the host.",
          "• Check the base URL, DNS, firewall, proxy, and TLS certificate.",
        ]
      : [
          "• Confirm the Genosyn server has internet access.",
          "• Check outbound DNS, firewall, proxy, and TLS settings on the Genosyn host.",
          "• Retry after confirming the model API is available.",
        ];
  }
  if (category === "timeout") {
    return [
      "• Confirm the model service is healthy and not overloaded.",
      "• Check proxy and load-balancer timeouts between Genosyn and the model API.",
      "• Retry once the service is responding normally.",
    ];
  }
  if (category === "authentication") {
    return [
      "• Replace the saved API key and confirm it is still active.",
      "• Confirm the key can access the configured model.",
    ];
  }
  if (category === "rate_limit") {
    return [
      "• Check the model account’s quota, billing status, and rate limits.",
      "• Wait for the limit to reset or switch the employee to another AI Model.",
    ];
  }
  if (category === "not_found") {
    return provider === "custom"
      ? [
          "• Confirm the base URL points at the OpenAI-compatible API root, commonly ending in /v1.",
          "• Confirm the configured model id exactly matches one exposed by the server.",
        ]
      : [
          "• Confirm the configured model id is valid and available to this API key.",
          "• Switch to a model the account can access if it was renamed or retired.",
        ];
  }
  if (category === "context") {
    return [
      "• Set the model’s context window accurately so Genosyn can compact before the limit.",
      "• Reduce unusually large Soul, Skill, attachment, or tool output content.",
    ];
  }
  if (category === "provider") {
    return [
      "• Retry after checking the model service’s status or server logs.",
      "• If the failure persists, switch the employee to another AI Model.",
    ];
  }
  return [
    "• Read the provider detail above for the rejected field or unsupported feature.",
    "• Confirm the model id and connection settings, then retry.",
  ];
}

/** Host-only endpoint preview. Never decrypt or render the stored full URL. */
function endpointLabel(model: AIModel): string | null {
  if (model.provider === "anthropic") return "api.anthropic.com";
  if (model.provider === "openai") return "api.openai.com";
  try {
    const cfg = JSON.parse(model.configJson || "{}") as Record<string, unknown>;
    const preview = typeof cfg.baseURLPreview === "string" ? cfg.baseURLPreview : "";
    return preview ? oneLine(preview, 300) : "custom endpoint (host unavailable)";
  } catch {
    return "custom endpoint (host unavailable)";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneLine(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim() || "Unknown error";
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
