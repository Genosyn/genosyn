import OpenAI from "openai";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { assertSafeOutboundUrl } from "../lib/outboundUrl.js";
import { readWindow } from "./agent/contextWindow.js";
import { readCustomEndpoint } from "./customEndpoint.js";

/**
 * Follow the model a self-hosted server serves.
 *
 * A custom endpoint's model id is free text the server must recognise. When an
 * operator restarted vLLM with another `--model`, every turn failed with "The
 * model … does not exist" until someone retyped the new id on each AI Model
 * card. Now a request the server rejects that way, from a server that serves a
 * single model, is sent to that model instead (see `agent/opencodeProxy.ts`),
 * and the card adopts it with the new model's context window.
 *
 * Only that rejection triggers a switch. A server's model list alone is not
 * proof: llama.cpp lists a file name but answers to any id, and LM Studio lists
 * what is loaded but loads other models on request. A server that lists
 * several models is never guessed at either.
 */

const LIST_TIMEOUT_MS = 5_000;

export type ServedModel = { id: string; contextWindow: number | null };

/** The models an OpenAI-compatible server lists, with any context window it reports. */
export async function listServedModels(
  baseURL: string,
  apiKey: string | null,
): Promise<ServedModel[]> {
  await assertSafeOutboundUrl(baseURL);
  const client = new OpenAI({
    apiKey: apiKey || "not-needed",
    baseURL: baseURL.trim().replace(/\/+$/, ""),
    timeout: LIST_TIMEOUT_MS,
    maxRetries: 0,
  });
  const list = await client.models.list();
  return list.data.map((entry) => ({ id: entry.id, contextWindow: readWindow(entry) }));
}

/**
 * The one model a server serves, for a model id left blank, or an error that
 * says what to enter instead.
 */
export async function soleServedModel(
  baseURL: string,
  apiKey: string | null,
): Promise<ServedModel> {
  const served = await listServedModels(baseURL, apiKey);
  if (served.length === 1) return served[0];
  if (served.length === 0) throw new Error("The server lists no models. Enter the Model id.");
  const shown = served.slice(0, 8).map((model) => model.id);
  throw new Error(
    `The server serves ${served.length} models (${shown.join(", ")}${served.length > shown.length ? ", …" : ""}). Enter the Model id to use.`,
  );
}

/**
 * Record that a custom-endpoint AI Model now uses `next`, the one model its
 * server serves, updating the stored row and the given entity. A window typed
 * in by hand is kept. Returns false, changing nothing, when the card was edited
 * meanwhile or cannot be read.
 */
export async function adoptServedModel(model: AIModel, next: ServedModel): Promise<boolean> {
  if (!readCustomEndpoint(model)) return false;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(model.configJson || "{}") as Record<string, unknown>;
  } catch {
    return false;
  }
  config.modelId = next.id;
  const configJson = JSON.stringify(config);
  const manualWindow = model.contextWindowSource === "manual";
  const contextWindow = manualWindow ? model.contextWindow : next.contextWindow;
  const contextWindowSource = manualWindow ? "manual" : next.contextWindow ? "probed" : null;
  try {
    // Only the configuration this turn read is replaced; a concurrent edit on
    // the card wins.
    const result = await AppDataSource.getRepository(AIModel).update(
      { id: model.id, configJson: model.configJson },
      { configJson, model: next.id, contextWindow, contextWindowSource },
    );
    if (result.affected !== 1) return false;
  } catch {
    return false;
  }
  model.configJson = configJson;
  model.model = next.id;
  model.contextWindow = contextWindow;
  model.contextWindowSource = contextWindowSource;
  return true;
}
