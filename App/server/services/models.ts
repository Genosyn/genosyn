import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Routine } from "../db/entities/Routine.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * Active-model bookkeeping for the one-to-many `AIEmployee` → `AIModel`
 * relationship.
 *
 * An employee can register several models and keep exactly one active. The
 * active model is the default for Routines and chat; dedicated employee chat
 * can select a different employee-owned model for an individual turn. These
 * helpers are the single place that maintains the "at most one active per
 * employee" invariant, so routes never hand-roll the flag flip.
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
 * Resolve the AI Model for a direct-chat turn. An explicit model id must name
 * one of the employee's own rows; null/undefined inherits the active model.
 */
export async function resolveChatModel(
  employeeId: string,
  modelId?: string | null,
): Promise<AIModel | null> {
  if (!modelId) return getActiveModel(employeeId);
  return AppDataSource.getRepository(AIModel).findOneBy({
    id: modelId,
    employeeId,
  });
}

/**
 * The model a routine should run on: its pinned {@link Routine.modelId} when
 * set, otherwise the employee's active model.
 *
 * The pin is validated on write and cleared when the model it names is
 * deleted, so a dangling id means something raced us or the row was edited
 * out-of-band. We fall back to the active model rather than failing the run —
 * the same brain the employee would have used anyway, and the alternative is a
 * scheduled routine silently going dark. `pinned` reports which path we took
 * so the runner can say so in the log.
 */
export async function resolveRoutineModel(routine: {
  employeeId: string;
  modelId: string | null;
}): Promise<{ model: AIModel | null; pinned: boolean }> {
  if (routine.modelId) {
    const repo = AppDataSource.getRepository(AIModel);
    const pinned = await repo.findOneBy({
      id: routine.modelId,
      employeeId: routine.employeeId,
    });
    if (pinned) return { model: pinned, pinned: true };
  }
  return { model: await getActiveModel(routine.employeeId), pinned: false };
}

/**
 * Clear the routine pins naming `modelId`, reverting those routines to
 * inheriting the employee's active model. Called when a model is deleted so a
 * pin never outlives the row it points at.
 *
 * `companyId` is only for the live-sync frame — every routine reachable from
 * one model belongs to that model's employee, so there is exactly one company
 * to announce to and the caller already knows it.
 */
export async function clearRoutinePins(modelId: string, companyId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  // Read the pinned ids first, purely to decide whether anything is worth
  // announcing. Not `UpdateResult.affected`: the drivers disagree on when it
  // is populated (see `routes/unsubscribe.ts`), and a count that comes back
  // null on Postgres would silence exactly the frame this exists to send.
  const pinned = await repo.find({ where: { modelId }, select: { id: true } });

  // Still by `{ modelId }` rather than the ids just read, so a pin written
  // between the two statements is cleared as well — a dangling pin outliving
  // its model is the bug this function exists to prevent.
  await repo.update({ modelId }, { modelId: null });

  // Then say so explicitly. A criteria `update()` broadcasts only the partial
  // it was handed — `{ modelId: null }`, with no `employeeId` — so the live-
  // sync subscriber has no FK to hop to a company on and every open Routines
  // page would keep showing a pin to a model that no longer exists. See
  // ROADMAP M31.
  if (pinned.length > 0) emitResourceChange(companyId, "routine");
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
