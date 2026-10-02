import OpenAI from "openai";
import type { AIModel } from "../db/entities/AIModel.js";
import { assertSafeOutboundUrl } from "../lib/outboundUrl.js";
import { readCustomEndpoint } from "./customEndpoint.js";

/**
 * Hold queued work while a self-hosted model server is down.
 *
 * A model server restarts for upgrades and stops under load. While it is down,
 * each queued Run that starts fails once the runtime's retries run out — about
 * a minute — so a five-minute restart could cost a whole queue of Runs. After
 * a Run on a custom endpoint fails with a model error, the queue asks that
 * endpoint whether it answers before starting the next Run on it, and keeps the
 * Runs waiting while it does not. The heartbeat asks again, so they start on
 * their own once the server is back.
 */

const PROBE_TIMEOUT_MS = 5_000;
/** Workers for several waiting Runs share one recent answer rather than each asking. */
const PROBE_FRESH_MS = 20_000;

const suspected = new Set<string>();
const probes = new Map<string, { at: number; answered: boolean }>();

/** A Run on this capacity key just failed with a model error. */
export function suspectModelOutage(capacityKey: string): void {
  suspected.add(capacityKey);
  probes.delete(capacityKey);
}

/**
 * Whether the queue may start a Run on this model now. Only a key with a
 * recent model failure is asked; a server that answers clears the suspicion.
 */
export async function modelAnswersForQueue(
  capacityKey: string,
  model: AIModel,
  now: number = Date.now(),
): Promise<boolean> {
  if (!suspected.has(capacityKey)) return true;
  const recent = probes.get(capacityKey);
  if (recent && now - recent.at < PROBE_FRESH_MS) return recent.answered;
  const answered = await modelEndpointAnswers(model);
  if (answered) {
    suspected.delete(capacityKey);
    probes.delete(capacityKey);
  } else {
    probes.set(capacityKey, { at: now, answered });
  }
  return answered;
}

/**
 * Ask a custom endpoint for its model list. Only a refused or broken connection
 * or a server error (5xx) means it is down. Any other answer — a wrong card or
 * key, a gateway without a model list, a slow reply — means the server is up:
 * those fail a Run for their own reasons, which waiting would not fix, and
 * holding the queue on them could hold it forever. A model that cannot be
 * asked is never held back.
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
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: cfg.baseURL.trim().replace(/\/+$/, ""),
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });
  try {
    await client.models.list();
    return true;
  } catch (error) {
    if (error instanceof OpenAI.APIConnectionTimeoutError) return true;
    if (error instanceof OpenAI.APIConnectionError) return false;
    const status = (error as { status?: unknown }).status;
    return !(typeof status === "number" && status >= 500);
  }
}

/** Test seam: forget the last answers but keep any suspicion. */
export function forgetModelProbesForTests(): void {
  probes.clear();
}

/** Test seam: forget everything. */
export function resetModelAvailabilityForTests(): void {
  suspected.clear();
  probes.clear();
}
