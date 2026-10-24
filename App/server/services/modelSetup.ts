import { randomUUID } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { agentRuntime } from "./agent/runtime.js";
import { residentOnlyRegistry } from "./agent/tools/toolRegistry.js";
import {
  discoverApiModels,
  modelSetupFailure,
  ModelSetupError,
  type ApiModelProvider,
  type ModelCatalog,
} from "./modelCatalog.js";
import { isModelConnected } from "./providers.js";
import { saveNewModel } from "./models.js";
import {
  decryptApiKey,
  decryptApiKeys,
  newStoredApiKey,
  readApiKeys,
  writeApiKeys,
  type StoredApiKey,
} from "./modelApiKeys.js";
import { pruneKeyHealth } from "./modelKeyHealth.js";

/** Exercise the same OpenCode runtime as employee Runs using one harmless tool. */
export async function verifyOpenCodeModel(model: AIModel): Promise<void> {
  let verified = false;
  try {
    await agentRuntime.run({
      model,
      system:
        "This is a connection test. Call connection_test exactly once with ok set to true. Do not do anything else.",
      messages: [{ role: "user", content: [{ type: "text", text: "Test the connection now." }] }],
      registry: residentOnlyRegistry([
        {
          name: "connection_test",
          description:
            "Confirm this AI Model can answer and use AI Employee tools. This tool has no side effects.",
          inputSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          readOnly: true,
          run: async (input) => {
            verified = input.ok === true;
            return {
              content: verified ? "Connection verified. Reply OK and finish." : "Expected ok=true.",
              isError: !verified,
            };
          },
        },
      ]),
      nativeCoding: false,
      signal: AbortSignal.timeout(120_000),
      maxSteps: 2,
    });
    if (!verified) {
      throw new ModelSetupError(
        "The AI Model responded but did not complete the tool-use test. Choose another model or try again.",
      );
    }
  } catch (error) {
    throw modelSetupFailure(error);
  }
}

/**
 * `configJson` with `apiKey` as the AI Model's primary key, and that key.
 * Backup keys stay as they are. Entering the current primary again keeps its
 * id, so its health carries on; entering one of the backups is refused, since
 * one key twice would only be refused twice — move it to the top instead.
 */
export function configWithApiKey(
  configJson: string,
  apiKey: string,
  companyId: string,
): { configJson: string; key: StoredApiKey } {
  const [current, ...backups] = readApiKeys(configJson);
  if (backups.some((backup) => decryptApiKey(backup) === apiKey)) {
    throw new ModelSetupError(
      "This key is already one of this AI Model's backup keys. Move it to the top of the API keys instead.",
      400,
    );
  }
  const key =
    current && decryptApiKey(current) === apiKey ? current : newStoredApiKey(apiKey, companyId);
  return { configJson: writeApiKeys(configJson, [key, ...backups]), key };
}

/**
 * A copy of `model` holding `key` alone, for a connection test that proves
 * that key works — with the backups on it, another key answering after it was
 * refused would vouch for it.
 */
export function withOnlyKey(model: AIModel, key: StoredApiKey): AIModel {
  return Object.assign(new AIModel(), model, { configJson: writeApiKeys(model.configJson, [key]) });
}

/**
 * Connect a new company AI Model with an API key, and attach it — as their
 * active model — to the AI Employees named in `attachTo` (none: the company
 * keeps it for later).
 */
export async function connectApiModel(options: {
  companyId: string;
  provider: ApiModelProvider;
  apiKey: string;
  model?: string;
  attachTo?: readonly string[];
}): Promise<AIModel> {
  const modelId =
    options.model || (await discoverApiModels(options.provider, options.apiKey)).recommendedModel;
  const repo = AppDataSource.getRepository(AIModel);
  const model = repo.create({
    id: randomUUID(),
    companyId: options.companyId,
    provider: options.provider,
    model: modelId,
    authMode: "apikey",
    configJson: "{}",
    connectedAt: null,
  });
  model.configJson = writeApiKeys("{}", [newStoredApiKey(options.apiKey, options.companyId)]);
  await verifyOpenCodeModel(model);
  model.connectedAt = new Date();
  // Nothing is saved or attached before a real model reply succeeds.
  return saveNewModel(model, options.attachTo ?? []);
}

/** Replace the primary key, keeping the backups; the new key is tested alone. */
export async function replaceApiKey(
  model: AIModel,
  apiKey: string,
  companyId: string,
): Promise<AIModel> {
  const { configJson, key } = configWithApiKey(model.configJson, apiKey, companyId);
  const candidate = Object.assign(new AIModel(), model, { configJson });
  await verifyOpenCodeModel(withOnlyKey(candidate, key));
  candidate.connectedAt = new Date();
  const saved = await saveVerifiedModel(model, candidate);
  await pruneKeyHealth(saved);
  return saved;
}

/**
 * The models a connected Claude or OpenAI AI Model's own keys can reach, so
 * changing which model it runs is a pick from a list rather than an ID typed
 * from memory, and no key is pasted again. The keys are tried in the order
 * requests use them: a primary the provider now refuses does not hide the list
 * a backup can still read. When every key fails, the primary's reason is the
 * one reported. Listing models stores nothing.
 */
export async function discoverStoredApiModels(model: AIModel): Promise<ModelCatalog> {
  if (
    model.authMode !== "apikey" ||
    (model.provider !== "anthropic" && model.provider !== "openai")
  ) {
    throw new ModelSetupError(
      "Only a Claude or OpenAI AI Model connected with an API key lists its models here.",
      400,
    );
  }
  const keys = decryptApiKeys(model.configJson);
  if (keys.length === 0) {
    throw new ModelSetupError("This AI Model has no API key to list its models with.", 400);
  }
  let first: unknown = null;
  for (const key of keys) {
    try {
      return await discoverApiModels(model.provider, key.apiKey);
    } catch (error) {
      first ??= error;
    }
  }
  throw modelSetupFailure(first, "load the available AI Models");
}

/** Model-only edits must not leave a connected badge on an unusable model. */
export async function verifyModelEdit(model: AIModel, modelId: string): Promise<void> {
  if (model.model === modelId) return;
  if (model.authMode === "customEndpoint") {
    throw new ModelSetupError(
      "Use the endpoint form to change a custom model. It tests and saves the endpoint and model ID together.",
    );
  }
  if (!isModelConnected(model) || model.authMode === "subscription") return;
  await verifyOpenCodeModel(Object.assign(new AIModel(), model, { model: modelId }));
}

export async function saveVerifiedModel(
  previous: AIModel,
  candidate: AIModel,
  options: { resetContext?: boolean } = {},
): Promise<AIModel> {
  const repo = AppDataSource.getRepository(AIModel);
  const result = await repo.update(
    {
      id: previous.id,
      companyId: previous.companyId,
      provider: previous.provider,
      authMode: previous.authMode,
      model: previous.model,
      configJson: previous.configJson,
    },
    {
      configJson: candidate.configJson,
      connectedAt: candidate.connectedAt,
      provider: candidate.provider,
      authMode: candidate.authMode,
      model: candidate.model,
      // A key test can take time. Preserve a concurrent context edit when the
      // model target is unchanged; only a new target invalidates that window.
      ...(options.resetContext ? { contextWindow: null, contextWindowSource: null } : {}),
    },
  );
  if (result.affected !== 1) {
    throw new ModelSetupError(
      "This AI Model changed while it was being tested. Please try again.",
      409,
    );
  }
  return repo.findOneByOrFail({ id: candidate.id, companyId: candidate.companyId });
}

/** Build and test the entire edited credential before replacing the previous working setup. */
export async function editApiModel(
  previous: AIModel,
  options: {
    provider: ApiModelProvider;
    model: string;
    apiKey?: string;
    companyId: string;
  },
): Promise<AIModel> {
  const changedAuth = previous.authMode !== "apikey" || previous.provider !== options.provider;
  if (changedAuth && !options.apiKey)
    throw new ModelSetupError("Enter the API key to test this new AI Model before saving.");
  const candidate = Object.assign(new AIModel(), previous, {
    provider: options.provider,
    authMode: "apikey",
    model: options.model,
    ...(changedAuth ? { configJson: "{}" } : {}),
    ...(changedAuth || options.model !== previous.model
      ? { contextWindow: null, contextWindowSource: null }
      : {}),
  });
  // A new key is tested alone. A model-only change is tested on every key, as
  // a Run would send it: the question is whether this AI Model answers.
  let tested: AIModel = candidate;
  if (options.apiKey) {
    const edited = configWithApiKey(candidate.configJson, options.apiKey, options.companyId);
    candidate.configJson = edited.configJson;
    tested = withOnlyKey(candidate, edited.key);
  }
  if (isModelConnected(candidate)) {
    await verifyOpenCodeModel(tested);
    candidate.connectedAt = new Date();
  }
  const saved = await saveVerifiedModel(previous, candidate, {
    resetContext: changedAuth || options.model !== previous.model,
  });
  // A new service starts with no keys of the old one; a replaced primary goes.
  await pruneKeyHealth(saved);
  return saved;
}
