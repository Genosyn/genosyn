import OpenAI from "openai";
import type { AIModel } from "../db/entities/AIModel.js";
import { assertSafeOutboundUrl } from "../lib/outboundUrl.js";
import { classifyKeyRefusal, orderedApiKeys } from "./agent/apiKeyRing.js";
import {
  classifyModelError,
  classifyModelResponse,
  classifyModelTransportError,
  modelUnavailability,
  type ModelUnavailability,
} from "./agent/modelOutage.js";
import { readCustomEndpoint } from "./customEndpoint.js";
import type { ModelCheckOutcome } from "./modelAvailability.js";

/**
 * The cheap checks that ask an unavailable AI Model whether it answers again
 * (`services/modelAvailability.ts` schedules them, one at a time, on a backoff).
 *
 * Each check uses the model's own credentials, on the server only, and asks
 * for as little as the service allows:
 *
 *   - **Anthropic** and **OpenAI** API keys: a one-word request for at most a
 *     token or sixteen — the real request path, because a model list can answer
 *     while the model itself is overloaded. The keys are tried as a connection
 *     test tries them (non-resting first, taking no turn in the pool); a key
 *     the provider refuses moves on to the next, and a check where every key is
 *     only refused for credit or authentication finds the *service* answering —
 *     the outage is over, and the work then fails for its real reason.
 *   - A **custom endpoint**: its model list, as the queue always asked it. Only
 *     a refused or broken connection or a 5xx means it is down; a slow answer
 *     means a busy server, which is up.
 *   - A **ChatGPT sign-in**: the same tiny isolated Codex turn the connection
 *     test runs, under the per-model lock. While a chat or Run holds the sign-in
 *     the check does not queue behind it — that turn's own outcome answers.
 *
 * Nothing a check learns is logged or stored but the classification, which
 * holds no key and no response body.
 */

/** How long a hosted model's check waits for an answer. */
export const HOSTED_CHECK_TIMEOUT_MS = 20_000;
/** How long a custom endpoint's model list may take; slower than this is a busy server. */
export const ENDPOINT_CHECK_TIMEOUT_MS = 10_000;

const HOSTED_API_BASES = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};
let hostedBases: { anthropic: string; openai: string } = { ...HOSTED_API_BASES };

/** Test seam: where hosted APIs are reached. */
export function setHostedModelApiBasesForTests(
  bases: Partial<{ anthropic: string; openai: string }> | null,
): void {
  hostedBases = { ...HOSTED_API_BASES, ...(bases ?? {}) };
}

const available: ModelCheckOutcome = { kind: "available" };
const unavailable = (unavailability: ModelUnavailability): ModelCheckOutcome => ({
  kind: "unavailable",
  unavailability,
});

/** Ask this AI Model whether it answers. Never throws. */
export async function checkModel(model: AIModel): Promise<ModelCheckOutcome> {
  try {
    if (model.authMode === "subscription") return await checkSubscriptionModel(model);
    if (model.authMode === "customEndpoint" || model.provider === "custom") {
      return await checkCustomEndpoint(model);
    }
    return await checkApiKeyModel(model);
  } catch (error) {
    const outage = classifyModelError(error);
    return outage ? unavailable(outage) : { kind: "unknown", reason: "the check could not run" };
  }
}

function hostedRequest(
  model: AIModel,
  apiKey: string,
): { url: string; headers: Record<string, string>; body: string } {
  if (model.provider === "anthropic") {
    return {
      url: `${hostedBases.anthropic}/messages`,
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    };
  }
  return {
    url: `${hostedBases.openai}/responses`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    // Sixteen is the least the Responses API accepts; an answer cut off there
    // is still an answer.
    body: JSON.stringify({ model: model.model, input: "ping", max_output_tokens: 16, store: false }),
  };
}

async function checkApiKeyModel(model: AIModel): Promise<ModelCheckOutcome> {
  const keys = await orderedApiKeys(model);
  if (keys.length === 0) return { kind: "unknown", reason: "no stored API key could be read" };
  let rateLimited: ModelUnavailability | null = null;
  for (const key of keys) {
    const request = hostedRequest(model, key.apiKey);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(HOSTED_CHECK_TIMEOUT_MS),
      });
    } catch (error) {
      const outage =
        classifyModelTransportError(error) ??
        (isTimeout(error) ? classifyModelResponse({ status: 504 }) : null);
      return outage ? unavailable(outage) : { kind: "unknown", reason: "the request did not go out" };
    }
    const body = await response.text().catch(() => "");
    if (response.ok) return available;
    const refusal = classifyKeyRefusal({ status: response.status, body, headers: response.headers });
    if (refusal) {
      // About this key, not the service: the next key may answer. A rate
      // limit on every key is the one refusal that is an outage.
      if (refusal.kind === "rate_limit") {
        const limited = classifyModelResponse({
          status: response.status,
          body,
          headers: response.headers,
        });
        if (
          limited &&
          (rateLimited === null ||
            (limited.retryAfterMs ?? Infinity) < (rateLimited.retryAfterMs ?? Infinity))
        )
          rateLimited = limited;
      }
      continue;
    }
    const outage = classifyModelResponse({
      status: response.status,
      body,
      headers: response.headers,
    });
    // Any other answer is the service answering, about this request.
    return outage ? unavailable(outage) : available;
  }
  return rateLimited ? unavailable(rateLimited) : available;
}

function isTimeout(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : null;
  return name === "TimeoutError";
}

async function checkCustomEndpoint(model: AIModel): Promise<ModelCheckOutcome> {
  const cfg = readCustomEndpoint(model);
  if (!cfg) return { kind: "unknown", reason: "the endpoint is not fully configured" };
  try {
    await assertSafeOutboundUrl(cfg.baseURL);
  } catch {
    return { kind: "unknown", reason: "the endpoint's address is not allowed" };
  }
  const outcome = await endpointCheck(cfg.baseURL, cfg.apiKey);
  return outcome ? unavailable(outcome) : available;
}

/**
 * Ask an OpenAI-compatible endpoint for its model list. Null when it answers —
 * anything but a refused or broken connection or a 5xx, a slow reply included:
 * a wrong card or key, a gateway without a model list, a busy server are all
 * up, and fail work for their own reasons, which waiting would not fix.
 */
async function endpointCheck(
  baseURL: string,
  apiKey: string | null | undefined,
): Promise<ModelUnavailability | null> {
  const client = new OpenAI({
    apiKey: apiKey || "not-needed",
    baseURL: baseURL.trim().replace(/\/+$/, ""),
    timeout: ENDPOINT_CHECK_TIMEOUT_MS,
    maxRetries: 0,
  });
  try {
    await client.models.list();
    return null;
  } catch (error) {
    if (error instanceof OpenAI.APIConnectionTimeoutError) return null;
    if (error instanceof OpenAI.APIConnectionError) {
      return (
        classifyModelTransportError(error.cause ?? error) ??
        classifyModelTransportError(new Error("fetch failed"))
      );
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 500) return classifyModelResponse({ status });
    return null;
  }
}

/**
 * Whether a custom endpoint answers, for the model proxy's in-turn wait
 * (`opencodeProxy.ts`): only a refused or broken connection or a 5xx is down.
 */
export async function endpointAnswers(
  baseURL: string,
  apiKey: string | null | undefined,
): Promise<boolean> {
  return (await endpointCheck(baseURL, apiKey)) === null;
}

/**
 * {@link endpointAnswers} for a custom AI Model row, its address checked
 * against the outbound policy first. A model that cannot be asked — hosted,
 * not configured, a refused address — is never held back.
 */
export async function modelEndpointAnswers(model: AIModel): Promise<boolean> {
  if (model.authMode !== "customEndpoint") return true;
  const cfg = readCustomEndpoint(model);
  if (!cfg) return true;
  try {
    await assertSafeOutboundUrl(cfg.baseURL);
  } catch {
    return true;
  }
  return endpointAnswers(cfg.baseURL, cfg.apiKey);
}

async function checkSubscriptionModel(model: AIModel): Promise<ModelCheckOutcome> {
  const { subscriptionModelBusy } = await import("./codexSubscription.js");
  if (subscriptionModelBusy(model.id)) {
    return { kind: "unknown", reason: "a chat or Run is using the sign-in" };
  }
  const { checkSubscriptionModelAnswers } = await import("./subscriptionModelSetup.js");
  try {
    await checkSubscriptionModelAnswers(model);
    return available;
  } catch (error) {
    const outage = classifyModelError(error);
    if (outage) return unavailable(outage);
    const record =
      error && typeof error === "object" ? (error as { name?: unknown; status?: unknown }) : null;
    // The test turn got no answer at all: nothing came back in time, or the
    // runtime stopped or never started the turn — this host's problem, which
    // says nothing either way.
    if (record?.name === "ModelSetupError" && typeof record.status === "number" && record.status >= 500) {
      return record.status === 504
        ? unavailable(modelUnavailability("timeout", {}))
        : { kind: "unknown", reason: "the ChatGPT runtime stopped before the check finished" };
    }
    // A turn that finished badly — a refused sign-in, a workspace without
    // access — is the service answering. A runtime that would not start is
    // this host's problem and says nothing either way.
    return record?.name === "ModelSetupError" || record?.name === "CodexAppServerError"
      ? available
      : { kind: "unknown", reason: "the check could not run" };
  }
}
