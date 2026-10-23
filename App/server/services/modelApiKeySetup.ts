import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { ModelSetupError } from "./modelCatalog.js";
import {
  findApiKey,
  holdsApiKeys,
  newStoredApiKey,
  readApiKeys,
  writeApiKeys,
  type StoredApiKey,
} from "./modelApiKeys.js";
import { pruneKeyHealth } from "./modelKeyHealth.js";
import { verifyOpenCodeModel, withOnlyKey } from "./modelSetup.js";

/**
 * Adding, removing and reordering an API-key AI Model's keys (the storage is
 * `modelApiKeys.ts`; what happens at run time is `agent/apiKeyRing.ts`).
 *
 * A key is tested before it is added, alone, with the same real tool-use reply
 * a new AI Model gets — the other keys must not answer for it — and nothing is
 * saved unless that test passes. There is no limit on how many keys an AI
 * Model holds. Every edit re-reads the row in its own short transaction and
 * applies to what is there now, so two edits made at once never undo each
 * other; the slow connection test runs before it, outside any transaction.
 */

function requireApiKeyModel(model: AIModel): void {
  if (!holdsApiKeys(model)) {
    throw new ModelSetupError(
      "Only Claude (Anthropic) and OpenAI AI Models connected with an API key hold backup keys.",
      400,
    );
  }
  if (readApiKeys(model.configJson).length === 0) {
    throw new ModelSetupError("Connect this AI Model with an API key first.", 400);
  }
}

const DUPLICATE = "This API key is already on this AI Model.";

/** Apply `edit` to the AI Model's keys as they are saved right now. */
async function editKeys(
  model: AIModel,
  options: { sameModel?: boolean },
  edit: (keys: StoredApiKey[]) => StoredApiKey[],
): Promise<AIModel> {
  return withSerializedTransaction(async (manager) => {
    const repo = manager.getRepository(AIModel);
    const current = await repo.findOne({
      where: { id: model.id, employeeId: model.employeeId },
      ...(AppDataSource.options.type === "postgres"
        ? { lock: { mode: "pessimistic_write" as const } }
        : {}),
    });
    if (!current) throw new ModelSetupError("Model not found", 404);
    if (!holdsApiKeys(current)) {
      throw new ModelSetupError(
        "This AI Model no longer connects with an API key. Reload and try again.",
        409,
      );
    }
    if (
      options.sameModel &&
      (current.provider !== model.provider || current.model !== model.model)
    ) {
      throw new ModelSetupError(
        "This AI Model changed while the key was being tested. Please try again.",
        409,
      );
    }
    current.configJson = writeApiKeys(current.configJson, edit(readApiKeys(current.configJson)));
    await repo.update({ id: current.id }, { configJson: current.configJson });
    await pruneKeyHealth(current, manager);
    return current;
  });
}

/**
 * Test `apiKey` on its own and, when it answers, add it as the last backup.
 * A key the AI Model already holds is refused.
 */
export async function addBackupKey(
  model: AIModel,
  apiKey: string,
  companyId: string,
): Promise<{ model: AIModel; key: StoredApiKey }> {
  requireApiKeyModel(model);
  if (findApiKey(readApiKeys(model.configJson), apiKey)) throw new ModelSetupError(DUPLICATE, 400);
  const key = newStoredApiKey(apiKey, companyId);
  await verifyOpenCodeModel(withOnlyKey(model, key));
  const saved = await editKeys(model, { sameModel: true }, (keys) => {
    // Someone may have added the same key while this one was being tested.
    if (findApiKey(keys, apiKey)) throw new ModelSetupError(DUPLICATE, 400);
    return [...keys, key];
  });
  return { model: saved, key };
}

/**
 * Remove one key. Removing the primary makes the next key the primary; the
 * last remaining key can't be removed — remove the AI Model instead.
 */
export async function removeApiKey(
  model: AIModel,
  keyId: string,
): Promise<{ model: AIModel; key: StoredApiKey }> {
  requireApiKeyModel(model);
  let removed: StoredApiKey | undefined;
  const saved = await editKeys(model, {}, (keys) => {
    removed = keys.find((key) => key.id === keyId);
    if (!removed) throw new ModelSetupError("API key not found", 404);
    if (keys.length === 1) {
      throw new ModelSetupError(
        "This is the AI Model's only API key. Add another key before removing this one, or remove the AI Model.",
        400,
      );
    }
    return keys.filter((key) => key.id !== keyId);
  });
  return { model: saved, key: removed! };
}

/**
 * Put the keys in the order given, which must name every key exactly once;
 * the first becomes the primary. A list that no longer matches the saved keys
 * — one was added or removed meanwhile — is refused rather than guessed at.
 */
export async function reorderApiKeys(
  model: AIModel,
  orderedIds: readonly string[],
): Promise<AIModel> {
  requireApiKeyModel(model);
  return editKeys(model, {}, (keys) => {
    const byId = new Map(keys.map((key) => [key.id, key]));
    if (
      orderedIds.length !== keys.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !byId.has(id))
    ) {
      throw new ModelSetupError(
        "The API keys changed since this list was loaded. Reload it and try again.",
        409,
      );
    }
    return orderedIds.map((id) => byId.get(id)!);
  });
}
