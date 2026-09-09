import { randomUUID } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { createModelClient } from "./agent/modelClients/index.js";
import {
  discoverApiModels,
  modelSetupFailure,
  ModelSetupError,
  type ApiModelProvider,
} from "./modelCatalog.js";
import { isModelConnected } from "./providers.js";
import { createActiveModel } from "./models.js";

/** Exercise the same streaming/tool API used by employee Runs, without executing tools. */
export async function verifyDirectModel(model: AIModel): Promise<void> {
  try {
    const resolved = await createModelClient(model);
    if ("error" in resolved) throw new ModelSetupError(resolved.error);
    const turn = await resolved.client.streamTurn({
      system:
        "This is a connection test. Call connection_test exactly once with ok set to true. Do not do anything else.",
      messages: [{ role: "user", content: [{ type: "text", text: "Test the connection now." }] }],
      tools: [
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
        },
      ],
      signal: AbortSignal.timeout(45_000),
      maxOutputTokens: 1024,
    });
    if (
      !turn.blocks.some(
        (block) =>
          block.type === "tool_use" && block.name === "connection_test" && block.input.ok === true,
      )
    ) {
      throw new ModelSetupError(
        "The AI Model responded but did not complete the tool-use test. Choose another model or try again.",
      );
    }
  } catch (error) {
    throw modelSetupFailure(error);
  }
}

export function configWithApiKey(model: AIModel, apiKey: string, companyId: string): string {
  const cfg = JSON.parse(model.configJson || "{}") as Record<string, unknown>;
  cfg.apiKeyEncrypted = encryptSecret(apiKey, companyId);
  cfg.apiKeyPreview = maskSecret(apiKey);
  return JSON.stringify(cfg);
}

export async function connectApiModel(options: {
  employeeId: string;
  companyId: string;
  provider: ApiModelProvider;
  apiKey: string;
  model?: string;
}): Promise<AIModel> {
  const modelId =
    options.model || (await discoverApiModels(options.provider, options.apiKey)).recommendedModel;
  const repo = AppDataSource.getRepository(AIModel);
  const model = repo.create({
    id: randomUUID(),
    employeeId: options.employeeId,
    provider: options.provider,
    model: modelId,
    authMode: "apikey",
    configJson: "{}",
    isActive: false,
    connectedAt: null,
  });
  model.configJson = configWithApiKey(model, options.apiKey, options.companyId);
  await verifyDirectModel(model);
  model.connectedAt = new Date();
  // Nothing is saved or activated before a real model reply succeeds.
  const saved = await createActiveModel(model);
  if (!saved) throw new ModelSetupError("This AI Employee no longer exists.", 409);
  return saved;
}

export async function replaceApiKey(
  model: AIModel,
  apiKey: string,
  companyId: string,
): Promise<AIModel> {
  const candidate = Object.assign(new AIModel(), model, {
    configJson: configWithApiKey(model, apiKey, companyId),
  });
  await verifyDirectModel(candidate);
  candidate.connectedAt = new Date();
  return saveVerifiedModel(model, candidate);
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
  await verifyDirectModel(Object.assign(new AIModel(), model, { model: modelId }));
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
      employeeId: previous.employeeId,
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
  return repo.findOneByOrFail({ id: candidate.id, employeeId: candidate.employeeId });
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
  if (options.apiKey)
    candidate.configJson = configWithApiKey(candidate, options.apiKey, options.companyId);
  if (isModelConnected(candidate)) {
    await verifyDirectModel(candidate);
    candidate.connectedAt = new Date();
  }
  return saveVerifiedModel(previous, candidate, {
    resetContext: changedAuth || options.model !== previous.model,
  });
}
