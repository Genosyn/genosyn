import { randomUUID } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { assertSafeOutboundUrl } from "../lib/outboundUrl.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { previewBaseURL, readCustomEndpoint } from "./customEndpoint.js";
import { ModelSetupError } from "./modelCatalog.js";
import { saveVerifiedModel, verifyDirectModel } from "./modelSetup.js";
import { createActiveModel } from "./models.js";

export type CustomModelSetup = {
  employeeId: string;
  companyId: string;
  baseURL: string;
  modelId: string;
  apiKey?: string;
};

/** Validate the target and its tool API before saving any credential or active-model change. */
export async function connectCustomModel(
  options: CustomModelSetup,
  previous?: AIModel,
): Promise<AIModel> {
  try {
    await assertSafeOutboundUrl(options.baseURL);
  } catch {
    throw new ModelSetupError(
      "This custom endpoint is not allowed by the outbound network policy. Check its URL and allowed hosts.",
      400,
    );
  }
  if (previous && (previous.authMode !== "customEndpoint" || previous.provider !== "custom")) {
    throw new ModelSetupError("This AI Model is not configured for a custom endpoint.", 400);
  }
  const repo = AppDataSource.getRepository(AIModel);
  const candidate = previous
    ? Object.assign(new AIModel(), previous)
    : repo.create({
        id: randomUUID(),
        employeeId: options.employeeId,
        provider: "custom",
        authMode: "customEndpoint",
        model: options.modelId,
        configJson: "{}",
        connectedAt: null,
        isActive: false,
      });
  const oldTarget = previous ? readCustomEndpoint(previous) : null;
  const config = JSON.parse(candidate.configJson || "{}") as Record<string, unknown>;
  config.baseURLEncrypted = encryptSecret(options.baseURL, options.companyId);
  config.baseURLPreview = previewBaseURL(options.baseURL);
  config.modelId = options.modelId;
  if (options.apiKey) {
    config.apiKeyEncrypted = encryptSecret(options.apiKey, options.companyId);
    config.apiKeyPreview = maskSecret(options.apiKey);
  } else {
    delete config.apiKeyEncrypted;
    delete config.apiKeyPreview;
  }
  candidate.configJson = JSON.stringify(config);
  candidate.model = options.modelId;
  const changedTarget =
    !oldTarget || oldTarget.baseURL !== options.baseURL || oldTarget.modelId !== options.modelId;
  if (changedTarget) {
    candidate.contextWindow = null;
    candidate.contextWindowSource = null;
  }
  await verifyDirectModel(candidate);
  candidate.connectedAt = new Date();
  if (previous) {
    return saveVerifiedModel(previous, candidate, { resetContext: changedTarget });
  }
  const saved = await createActiveModel(candidate);
  if (!saved) throw new ModelSetupError("This AI Employee no longer exists.", 409);
  return saved;
}
