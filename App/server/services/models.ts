import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";

/**
 * Active-model bookkeeping for the one-to-many `AIEmployee` → `AIModel`
 * relationship.
 *
 * An employee can register several models and keep exactly one active. The
 * runner + chat seams always spawn the active one. These helpers are the
 * single place that maintains the "at most one active per employee"
 * invariant, so routes never hand-roll the flag flip.
 */

type ActiveShape = { id: string; isActive: boolean; createdAt: Date };

/**
 * Resolve which model id is *effectively* active for a set of an employee's
 * models. Prefers the explicitly-flagged row; falls back to the most-recently
 * created one when none is flagged. The fallback covers rows that predate the
 * `isActive` column (they migrate in as `false`) and any transient state where
 * the flag was cleared but not re-set — reads stay correct without a data
 * backfill.
 */
export function effectiveActiveId(models: ActiveShape[]): string | null {
  if (models.length === 0) return null;
  const flagged = models.find((m) => m.isActive);
  if (flagged) return flagged.id;
  let newest = models[0];
  for (const m of models) {
    if (m.createdAt.getTime() > newest.createdAt.getTime()) newest = m;
  }
  return newest.id;
}

/** The employee's active model, or null if they have none. */
export async function getActiveModel(employeeId: string): Promise<AIModel | null> {
  const repo = AppDataSource.getRepository(AIModel);
  const models = await repo.find({ where: { employeeId } });
  const id = effectiveActiveId(models);
  return models.find((m) => m.id === id) ?? null;
}

/**
 * Flip the active flag to `modelId`, clearing it on every sibling. Runs in a
 * transaction so a reader never sees zero or two active rows. Returns false if
 * the model doesn't belong to the employee.
 */
export async function setActiveModel(employeeId: string, modelId: string): Promise<boolean> {
  return AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(AIModel);
    const target = await repo.findOneBy({ id: modelId, employeeId });
    if (!target) return false;
    await repo.update({ employeeId }, { isActive: false });
    await repo.update({ id: modelId }, { isActive: true });
    return true;
  });
}
