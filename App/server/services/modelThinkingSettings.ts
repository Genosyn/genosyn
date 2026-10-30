import type { ModelEffort } from "../../shared/modelEffort.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { thinkingSettingsProblem } from "./modelEffort.js";

/**
 * Save how hard an AI Model thinks in chat (Settings → AI Models): its default
 * thinking level, the highest level Members may choose, and — for a custom
 * endpoint only — whether it offers levels at all. Each level must be one the
 * model offers and the default may not sit above the ceiling; turning a
 * custom endpoint's levels off therefore clears both.
 *
 * Conversations keep the level their Members chose. Each turn resolves it
 * against these settings when it is accepted (`chatThinking.ts`), so a lower
 * ceiling holds the next message to it, and the reply says so.
 */
export async function saveModelThinkingSettings(
  model: AIModel,
  input: {
    defaultEffort: ModelEffort | null;
    effortCeiling: ModelEffort | null;
    customThinkingLevels?: boolean;
  },
): Promise<{ model: AIModel } | { error: string }> {
  const custom = model.provider === "custom" || model.authMode === "customEndpoint";
  if (input.customThinkingLevels !== undefined && !custom) {
    return {
      error:
        "Only a custom endpoint turns thinking levels on or off. This AI Model's levels come from its service.",
    };
  }
  const customThinkingLevels = custom
    ? (input.customThinkingLevels ?? model.customThinkingLevels)
    : false;
  const problem = thinkingSettingsProblem(
    { provider: model.provider, model: model.model, authMode: model.authMode, customThinkingLevels },
    input,
  );
  if (problem) return { error: problem };
  const changes = {
    defaultEffort: input.defaultEffort,
    effortCeiling: input.effortCeiling,
    customThinkingLevels,
  };
  await AppDataSource.getRepository(AIModel).update({ id: model.id }, changes);
  Object.assign(model, changes);
  return { model };
}
