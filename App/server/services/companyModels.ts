import { In, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../db/entities/AIModelKeyHealth.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { Routine } from "../db/entities/Routine.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { cancelSubscriptionDeviceLoginsForModel } from "./codexSubscription.js";
import { readApiKeys } from "./modelApiKeys.js";
import { ModelSetupError } from "./modelCatalog.js";
import { areExactDuplicates, duplicateIdsByModel } from "./modelDuplicates.js";
import { deleteKeyHealth } from "./modelKeyHealth.js";
import {
  clearModelPins,
  flipActive,
  lockEmployees,
  modelUsers,
  promoteSurvivor,
  type ModelUser,
} from "./models.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * The company's AI Models as Settings → AI Models manages them: every model,
 * who uses it, which are exact duplicates of each other, removing one, and
 * merging duplicates into one. Attaching and detaching live in `models.ts`
 * with the rest of the attachment bookkeeping.
 *
 * A model is a company asset with one set of credentials, so removing it is
 * guarded: while any AI Employee still uses it the removal is refused, unless
 * the caller explicitly asks to detach it from everyone first.
 */

/** One company AI Model with the employees using it and its exact duplicates. */
export type CompanyModelEntry = {
  model: AIModel;
  users: ModelUser[];
  duplicateIds: string[];
};

/** The company's AI Models, newest first, with who uses each and their duplicates. */
export async function listCompanyModels(companyId: string): Promise<CompanyModelEntry[]> {
  const models = await AppDataSource.getRepository(AIModel).find({
    where: { companyId },
    order: { createdAt: "DESC", id: "ASC" },
  });
  if (models.length === 0) return [];
  const users = await modelUsers(companyId);
  const duplicates = duplicateIdsByModel(models);
  return models.map((model) => ({
    model,
    users: users.get(model.id) ?? [],
    duplicateIds: duplicates.get(model.id) ?? [],
  }));
}

/** One company AI Model, or null when it is not this company's. */
export async function findCompanyModel(
  companyId: string,
  modelId: string,
): Promise<AIModel | null> {
  return AppDataSource.getRepository(AIModel).findOneBy({ id: modelId, companyId });
}

/** One company AI Model as {@link listCompanyModels} shows it. */
export async function companyModelEntry(
  companyId: string,
  modelId: string,
): Promise<CompanyModelEntry | null> {
  const entries = await listCompanyModels(companyId);
  return entries.find((entry) => entry.model.id === modelId) ?? null;
}

/** "Ada", "Ada and Grace", "Ada, Grace and Linus". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Removing a model some AI Employees still use, without asking to detach it. */
export class ModelInUseError extends ModelSetupError {
  constructor(readonly users: readonly ModelUser[]) {
    super(
      `${nameList(users.map((user) => user.name))} ${
        users.length === 1 ? "still uses" : "still use"
      } this AI Model. Detach it first, or remove it from every AI Employee at once.`,
      409,
    );
    this.name = "ModelInUseError";
  }

  override responseBody(): { error: string; employees: Array<{ id: string; name: string }> } {
    return {
      error: this.message,
      employees: this.users.map((user) => ({ id: user.id, name: user.name })),
    };
  }
}

export type RemovedModel = {
  model: AIModel;
  /** The employees it was detached from on the way out. */
  detachedFrom: ModelUser[];
};

/**
 * Remove an AI Model from the company: its credentials, backup keys and their
 * health go with it, Routine and mailbox pins naming it go back to each
 * employee's active model, and a ChatGPT sign-in still in progress for it is
 * cancelled. While any AI Employee uses it this is refused with who they are
 * — unless `detachFromEmployees`, when it is detached from each of them first
 * and each switches to its most recently attached other model.
 */
export async function removeCompanyModel(options: {
  companyId: string;
  modelId: string;
  detachFromEmployees: boolean;
}): Promise<RemovedModel> {
  const { companyId, modelId } = options;
  const model = await findCompanyModel(companyId, modelId);
  if (!model) throw new ModelSetupError("AI Model not found", 404);
  const users = (await modelUsers(companyId)).get(modelId) ?? [];
  if (users.length > 0 && !options.detachFromEmployees) throw new ModelInUseError(users);
  await cancelSubscriptionDeviceLoginsForModel(modelId);
  const clearedPins = await withSerializedTransaction(async (manager) => {
    const current = await lockedModels(manager, companyId, [modelId]);
    if (current.length === 0) throw new ModelSetupError("AI Model not found", 404);
    const rows = await manager.getRepository(EmployeeModel).find({ where: { modelId } });
    // Somebody attached it while this request was on its way.
    if (rows.length > 0 && !options.detachFromEmployees) {
      throw new ModelInUseError((await modelUsers(companyId, manager)).get(modelId) ?? []);
    }
    const employeeIds = [...new Set(rows.map((row) => row.employeeId))];
    await lockEmployees(manager, companyId, employeeIds);
    await manager.getRepository(EmployeeModel).delete({ modelId });
    for (const employeeId of employeeIds) await promoteSurvivor(manager, employeeId);
    const { routines } = await clearModelPins(manager, modelId);
    await deleteKeyHealth([modelId], manager);
    await manager.getRepository(AIModel).delete({ id: modelId, companyId });
    return routines;
  });
  emitResourceChange(companyId, "employee");
  if (clearedPins > 0) emitResourceChange(companyId, "routine");
  return { model, detachedFrom: users };
}

async function lockedModels(
  manager: EntityManager,
  companyId: string,
  ids: readonly string[],
): Promise<AIModel[]> {
  return manager.getRepository(AIModel).find({
    where: { id: In([...ids]), companyId },
    order: { id: "ASC" },
    ...(AppDataSource.options.type === "postgres"
      ? { lock: { mode: "pessimistic_write" as const } }
      : {}),
  });
}

/** The fields whose change makes a model a different model. */
function sameSetup(a: AIModel, b: AIModel): boolean {
  return (
    a.provider === b.provider &&
    a.authMode === b.authMode &&
    a.model === b.model &&
    a.configJson === b.configJson
  );
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Fold a duplicate's key health into the kept model's: the keys are the same
 * keys in the same order (that is what made them duplicates), so each kept
 * key takes the latest use, the latest refusal and the longest rest either
 * copy recorded.
 */
async function mergeKeyHealth(
  manager: EntityManager,
  target: AIModel,
  duplicate: AIModel,
): Promise<void> {
  const targetKeys = readApiKeys(target.configJson);
  const duplicateKeys = readApiKeys(duplicate.configJson);
  if (targetKeys.length === 0 || targetKeys.length !== duplicateKeys.length) return;
  const repo = manager.getRepository(AIModelKeyHealth);
  const rows = await repo.find({ where: { modelId: In([target.id, duplicate.id]) } });
  const health = (modelId: string, keyId: string) =>
    rows.find((row) => row.modelId === modelId && row.keyId === keyId) ?? null;
  for (let index = 0; index < targetKeys.length; index += 1) {
    const kept = health(target.id, targetKeys[index].id);
    const other = health(duplicate.id, duplicateKeys[index].id);
    if (!other) continue;
    const refusal =
      (other.lastErrorAt?.getTime() ?? 0) > (kept?.lastErrorAt?.getTime() ?? 0) ? other : kept;
    await repo.upsert(
      {
        modelId: target.id,
        keyId: targetKeys[index].id,
        lastUsedAt: later(kept?.lastUsedAt ?? null, other.lastUsedAt),
        lastErrorAt: refusal?.lastErrorAt ?? null,
        lastErrorStatus: refusal?.lastErrorStatus ?? null,
        lastErrorKind: refusal?.lastErrorKind ?? null,
        lastErrorMessage: refusal?.lastErrorMessage ?? null,
        coolDownUntil: later(kept?.coolDownUntil ?? null, other.coolDownUntil),
      },
      { conflictPaths: ["modelId", "keyId"], skipUpdateIfNoValuesChanged: false },
    );
  }
}

export type MergedModels = {
  model: AIModel;
  /** The duplicates folded into it, now removed. */
  merged: AIModel[];
  /** Employees that moved onto the kept model from a duplicate. */
  movedEmployees: number;
};

/**
 * Fold exact duplicates of one AI Model into it, so one set of keys serves
 * everyone who used any copy.
 *
 * Every employee on a duplicate is attached to the kept model instead, and
 * keeps it active if the duplicate was its active model; an employee that
 * already had the kept model just loses its second copy. Routine pins,
 * mailbox pins and Work sessions follow onto the kept model, each key's
 * health is folded in, and the duplicates are removed. The kept model's
 * settings — context window, concurrent Runs — are the ones that stay.
 *
 * Refused unless every named model is, right now, an exact duplicate of the
 * kept one: a model edited after the page loaded is not merged on its old
 * likeness.
 */
export async function mergeDuplicateModels(options: {
  companyId: string;
  targetId: string;
  duplicateIds: readonly string[];
}): Promise<MergedModels> {
  const { companyId, targetId } = options;
  const ids = [...new Set(options.duplicateIds)].filter((id) => id !== targetId);
  if (ids.length === 0) {
    throw new ModelSetupError("Choose at least one duplicate AI Model to merge.", 400);
  }
  const loaded = await AppDataSource.getRepository(AIModel).find({
    where: { companyId, id: In([targetId, ...ids]) },
  });
  const target = loaded.find((model) => model.id === targetId);
  if (!target) throw new ModelSetupError("AI Model not found", 404);
  const duplicates = ids.map((id) => loaded.find((model) => model.id === id));
  if (duplicates.some((model) => !model)) throw new ModelSetupError("AI Model not found", 404);
  const checked = duplicates as AIModel[];
  if (!checked.every((duplicate) => areExactDuplicates(target, duplicate))) {
    throw new ModelSetupError(
      "These AI Models are no longer exact duplicates. Reload the page and try again.",
      409,
    );
  }
  for (const duplicate of checked) await cancelSubscriptionDeviceLoginsForModel(duplicate.id);

  const movedEmployees = await withSerializedTransaction(async (manager) => {
    const fresh = await lockedModels(manager, companyId, [targetId, ...ids]);
    const changed = [target, ...checked].some((model) => {
      const now = fresh.find((row) => row.id === model.id);
      return !now || !sameSetup(now, model);
    });
    if (changed) {
      throw new ModelSetupError(
        "One of these AI Models changed while they were being merged. Reload the page and try again.",
        409,
      );
    }
    const attachments = manager.getRepository(EmployeeModel);
    const everyone = await attachments.find({ where: { modelId: In([targetId, ...ids]) } });
    await lockEmployees(manager, companyId, [...new Set(everyone.map((row) => row.employeeId))]);
    const holders = new Set(
      everyone.filter((row) => row.modelId === targetId).map((row) => row.employeeId),
    );
    let moved = 0;
    for (const duplicate of checked) {
      const rows = everyone
        .filter((row) => row.modelId === duplicate.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const row of rows) {
        if (holders.has(row.employeeId)) {
          await attachments.delete({ id: row.id });
          if (row.isActive) await flipActive(manager, row.employeeId, targetId);
        } else {
          await attachments.update({ id: row.id }, { modelId: targetId });
          holders.add(row.employeeId);
          moved += 1;
        }
      }
      await manager.getRepository(Routine).update({ modelId: duplicate.id }, { modelId: targetId });
      await manager
        .getRepository(MailAccount)
        .update({ companyId, aiAnalysisModelId: duplicate.id }, { aiAnalysisModelId: targetId });
      await manager
        .getRepository(RepositoryWorkSession)
        .update({ companyId, modelId: duplicate.id }, { modelId: targetId });
      await mergeKeyHealth(manager, target, duplicate);
      await deleteKeyHealth([duplicate.id], manager);
      await manager.getRepository(AIModel).delete({ id: duplicate.id, companyId });
    }
    return moved;
  });
  emitResourceChange(companyId, "employee");
  emitResourceChange(companyId, "routine");
  return { model: target, merged: checked, movedEmployees };
}

/** Delete every AI Model of a company and its attachments — the company is going. */
export async function deleteCompanyModelRows(
  companyId: string,
  manager: EntityManager,
): Promise<void> {
  const ids = (
    await manager.find(AIModel, { where: { companyId }, select: { id: true } })
  ).map((model) => model.id);
  await deleteKeyHealth(ids, manager);
  await manager.delete(EmployeeModel, { companyId });
  await manager.delete(AIModel, { companyId });
}
