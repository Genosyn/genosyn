import { In, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Routine } from "../db/entities/Routine.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { ModelSetupError } from "./modelCatalog.js";
import { isModelConnected } from "./providers.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * Which company AI Models each AI Employee uses, and which one is active.
 *
 * AI Models belong to the company; an `EmployeeModel` row attaches one to an
 * employee. An employee can have several attached and keeps exactly one
 * active: the default for Routines and chat, while dedicated employee chat
 * may select another attached model for a single turn. These helpers are the
 * one place that reads attachments and maintains the "at most one active per
 * employee" invariant, so routes never hand-roll the flag flip — and the one
 * place every runtime path resolves an employee's brain through, so a model
 * detached from an employee stops answering for it everywhere at once.
 */

type ActiveShape = { id: string; isActive: boolean; createdAt: Date };

/**
 * Resolve which model id is *effectively* active among an employee's
 * attachments. Prefers the explicitly-flagged one; falls back to the most
 * recently attached one when none is flagged. The fallback covers any
 * transient state where the flag was cleared but not re-set — reads stay
 * correct without a backfill.
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

/** One employee's attached AI Models, most recently attached first, and its active one. */
export type AttachedModels = {
  models: AIModel[];
  /** The model its Routines and chat use; null when it has none. */
  activeId: string | null;
};

function attachmentShapes(rows: readonly EmployeeModel[]): ActiveShape[] {
  return rows.map((row) => ({ id: row.modelId, isActive: row.isActive, createdAt: row.createdAt }));
}

/**
 * Every listed employee's attached AI Models, in two indexed reads however
 * many employees are asked about. An attachment whose model is gone or
 * belongs to another company is ignored rather than trusted.
 */
export async function attachedModelsByEmployee(
  employeeIds: readonly string[],
  manager: EntityManager = AppDataSource.manager,
): Promise<Map<string, AttachedModels>> {
  const ids = [...new Set(employeeIds)];
  const result = new Map<string, AttachedModels>(
    ids.map((id) => [id, { models: [], activeId: null }]),
  );
  if (ids.length === 0) return result;
  const rows = await manager.getRepository(EmployeeModel).find({
    where: { employeeId: In(ids) },
    order: { createdAt: "DESC", id: "DESC" },
  });
  if (rows.length === 0) return result;
  const models = await manager.getRepository(AIModel).find({
    where: { id: In([...new Set(rows.map((row) => row.modelId))]) },
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  const rowsByEmployee = new Map<string, EmployeeModel[]>();
  for (const row of rows) {
    const model = byId.get(row.modelId);
    if (!model || model.companyId !== row.companyId) continue;
    const list = rowsByEmployee.get(row.employeeId);
    if (list) list.push(row);
    else rowsByEmployee.set(row.employeeId, [row]);
  }
  for (const [employeeId, list] of rowsByEmployee) {
    result.set(employeeId, {
      models: list.map((row) => byId.get(row.modelId)!),
      activeId: effectiveActiveId(attachmentShapes(list)),
    });
  }
  return result;
}

/** One employee's attached AI Models and its active one. */
export async function attachedModels(employeeId: string): Promise<AttachedModels> {
  return (await attachedModelsByEmployee([employeeId])).get(employeeId)!;
}

/** The employee's active model, or null if it has none. */
export async function getActiveModel(employeeId: string): Promise<AIModel | null> {
  const { models, activeId } = await attachedModels(employeeId);
  return models.find((m) => m.id === activeId) ?? null;
}

/** The AI Model `modelId`, if it is attached to this employee. */
export async function findAttachedModel(
  employeeId: string,
  modelId: string,
): Promise<AIModel | null> {
  const row = await AppDataSource.getRepository(EmployeeModel).findOneBy({ employeeId, modelId });
  if (!row) return null;
  return AppDataSource.getRepository(AIModel).findOneBy({ id: modelId, companyId: row.companyId });
}

/** Is `modelId` attached to this employee? */
export async function isModelAttached(employeeId: string, modelId: string): Promise<boolean> {
  return (await findAttachedModel(employeeId, modelId)) !== null;
}

/**
 * Resolve the AI Model for a direct-chat turn. An explicit model id must name
 * one of the employee's attached models; null/undefined inherits the active one.
 */
export async function resolveChatModel(
  employeeId: string,
  modelId?: string | null,
): Promise<AIModel | null> {
  if (!modelId) return getActiveModel(employeeId);
  return findAttachedModel(employeeId, modelId);
}

/**
 * The model a routine should run on: its pinned {@link Routine.modelId} when
 * that model is still attached to the routine's employee, otherwise the
 * employee's active model.
 *
 * The pin is validated on write and cleared when the model it names is
 * detached from the employee or removed, so a dangling id means something
 * raced us or the row was edited out-of-band. We fall back to the active
 * model rather than failing the run — the same brain the employee would have
 * used anyway, and the alternative is a scheduled routine silently going
 * dark. `pinned` reports which path we took so the runner can say so in the
 * log.
 */
export async function resolveRoutineModel(routine: {
  employeeId: string;
  modelId: string | null;
}): Promise<{ model: AIModel | null; pinned: boolean }> {
  if (routine.modelId) {
    const pinned = await findAttachedModel(routine.employeeId, routine.modelId);
    if (pinned) return { model: pinned, pinned: true };
  }
  return { model: await getActiveModel(routine.employeeId), pinned: false };
}

/**
 * Clear the pins naming `modelId` — on the listed employees' Routines and
 * mailboxes, or on every one when no employees are named (the model is being
 * removed) — reverting them to the employee's active model. Called when a
 * model is detached or removed so a pin never outlives the attachment it
 * relies on.
 */
export async function clearModelPins(
  manager: EntityManager,
  modelId: string,
  employeeIds?: readonly string[],
): Promise<{ routines: number }> {
  if (employeeIds && employeeIds.length === 0) return { routines: 0 };
  const scope = employeeIds ? { employeeId: In([...employeeIds]) } : {};
  // Read the pinned ids first, purely to decide whether anything is worth
  // announcing. Not `UpdateResult.affected`: the drivers disagree on when it
  // is populated, and a count that comes back null on Postgres would silence
  // exactly the frame the caller sends.
  const pinned = await manager
    .getRepository(Routine)
    .find({ where: { modelId, ...scope }, select: { id: true } });
  // Still by criteria rather than the ids just read, so a pin written between
  // the two statements is cleared as well.
  await manager.getRepository(Routine).update({ modelId, ...scope }, { modelId: null });
  await manager
    .getRepository(MailAccount)
    .update(
      employeeIds
        ? { aiAnalysisModelId: modelId, aiAnalysisEmployeeId: In([...employeeIds]) }
        : { aiAnalysisModelId: modelId },
      { aiAnalysisModelId: null },
    );
  return { routines: pinned.length };
}

/**
 * Lock the employees' rows on Postgres so every attachment writer for an
 * employee serializes on it (an empty sibling update locks no rows), and
 * return the ones that exist in this company. SQLite transactions are already
 * exclusive.
 */
export async function lockEmployees(
  manager: EntityManager,
  companyId: string,
  employeeIds: readonly string[],
): Promise<AIEmployee[]> {
  if (employeeIds.length === 0) return [];
  return manager.getRepository(AIEmployee).find({
    where: { id: In([...new Set(employeeIds)]), companyId },
    select: { id: true, name: true, companyId: true },
    order: { id: "ASC" },
    ...(AppDataSource.options.type === "postgres"
      ? { lock: { mode: "pessimistic_write" as const } }
      : {}),
  });
}

/** Make `modelId` the employee's only active attachment. */
export async function flipActive(manager: EntityManager, employeeId: string, modelId: string) {
  const repo = manager.getRepository(EmployeeModel);
  await repo.update({ employeeId }, { isActive: false });
  await repo.update({ employeeId, modelId }, { isActive: true });
}

/**
 * After an employee's active attachment went, make the most recently attached
 * one left active, so the employee always has a defined brain while it has
 * any model at all.
 */
export async function promoteSurvivor(
  manager: EntityManager,
  employeeId: string,
): Promise<void> {
  const rows = await manager.getRepository(EmployeeModel).find({ where: { employeeId } });
  if (rows.length === 0 || rows.some((row) => row.isActive)) return;
  const promote = effectiveActiveId(attachmentShapes(rows));
  if (promote) await flipActive(manager, employeeId, promote);
}

/**
 * Save a new company AI Model and attach it to `attachTo`, making it each
 * one's active model — the newest model an employee gets is the one it uses,
 * and Make active switches back. Nothing is saved when a named employee is no
 * longer in the company.
 */
export async function saveNewModel(
  model: AIModel,
  attachTo: readonly string[] = [],
): Promise<AIModel> {
  const saved = await withSerializedTransaction(async (manager) => {
    const employees = await lockEmployees(manager, model.companyId, attachTo);
    if (employees.length !== new Set(attachTo).size) {
      throw new ModelSetupError("This AI Employee no longer exists.", 409);
    }
    const row = await manager.getRepository(AIModel).save(model);
    for (const employee of employees) {
      await manager.getRepository(EmployeeModel).update(
        { employeeId: employee.id },
        { isActive: false },
      );
      await manager.getRepository(EmployeeModel).insert({
        companyId: model.companyId,
        employeeId: employee.id,
        modelId: row.id,
        isActive: true,
      });
    }
    return row;
  });
  emitResourceChange(model.companyId, "employee");
  return saved;
}

export type AttachResult = {
  model: AIModel;
  /** Employees the model was attached to by this call. */
  attached: AIEmployee[];
  /** Employees it was already attached to. */
  alreadyAttached: AIEmployee[];
};

/**
 * Attach a company AI Model to each of `employeeIds`.
 *
 * With `makeActive` (the default) the model becomes each one's active model,
 * as adding a model always has; without it, it is active only for an
 * employee that has no other. Only a connected model may be attached — an
 * employee switched to a model still waiting for its key or sign-in would
 * stop working — and every employee must belong to the model's company. An
 * employee that already has it keeps its attachment (and is made active when
 * asked). Nothing is written when any check fails.
 */
export async function attachModel(options: {
  companyId: string;
  modelId: string;
  employeeIds: readonly string[];
  makeActive?: boolean;
}): Promise<AttachResult> {
  const { companyId, modelId } = options;
  const makeActive = options.makeActive ?? true;
  const requested = [...new Set(options.employeeIds)];
  const result = await withSerializedTransaction(async (manager) => {
    const model = await manager.getRepository(AIModel).findOne({
      where: { id: modelId, companyId },
      ...(AppDataSource.options.type === "postgres"
        ? { lock: { mode: "pessimistic_write" as const } }
        : {}),
    });
    if (!model) throw new ModelSetupError("AI Model not found", 404);
    if (!isModelConnected(model)) {
      throw new ModelSetupError(
        "This AI Model isn't connected yet. Finish connecting it before attaching it to AI Employees.",
        400,
      );
    }
    const employees = await lockEmployees(manager, companyId, requested);
    if (employees.length !== requested.length) {
      throw new ModelSetupError("AI Employee not found", 404);
    }
    const repo = manager.getRepository(EmployeeModel);
    const existing = await repo.find({ where: { employeeId: In(requested) } });
    const attached: AIEmployee[] = [];
    const alreadyAttached: AIEmployee[] = [];
    for (const employee of employees) {
      const own = existing.filter((row) => row.employeeId === employee.id);
      const current = own.find((row) => row.modelId === model.id);
      if (current) {
        alreadyAttached.push(employee);
        if (makeActive && !current.isActive) await flipActive(manager, employee.id, model.id);
        continue;
      }
      await repo.insert({ companyId, employeeId: employee.id, modelId: model.id, isActive: false });
      if (makeActive || own.length === 0) await flipActive(manager, employee.id, model.id);
      attached.push(employee);
    }
    return { model, attached, alreadyAttached };
  });
  emitResourceChange(companyId, "employee");
  return result;
}

export type DetachResult = {
  model: AIModel;
  detached: AIEmployee[];
  /** How many Routine pins went with the attachments. */
  clearedRoutinePins: number;
};

/**
 * Detach a company AI Model from each of `employeeIds`. The model itself, its
 * keys and every other employee's attachment stay exactly as they were. An
 * employee whose active model this was switches to its most recently attached
 * other model; its Routines pinned to this model go back to the active one.
 */
export async function detachModel(options: {
  companyId: string;
  modelId: string;
  employeeIds: readonly string[];
}): Promise<DetachResult> {
  const { companyId, modelId } = options;
  const requested = [...new Set(options.employeeIds)];
  const result = await withSerializedTransaction(async (manager) => {
    const model = await manager.getRepository(AIModel).findOneBy({ id: modelId, companyId });
    if (!model) throw new ModelSetupError("AI Model not found", 404);
    const employees = await lockEmployees(manager, companyId, requested);
    if (employees.length !== requested.length) {
      throw new ModelSetupError("AI Employee not found", 404);
    }
    const repo = manager.getRepository(EmployeeModel);
    const rows = await repo.find({ where: { modelId, employeeId: In(requested) } });
    const missing = employees.find((employee) => !rows.some((row) => row.employeeId === employee.id));
    if (missing) {
      throw new ModelSetupError(`${missing.name} doesn't use this AI Model.`, 404);
    }
    for (const row of rows) await repo.delete({ id: row.id });
    // Whether the detached model was flagged active or only the newest, each
    // employee left with any model gets an explicitly active one.
    for (const employee of employees) await promoteSurvivor(manager, employee.id);
    const { routines } = await clearModelPins(manager, modelId, requested);
    return { model, detached: employees, clearedRoutinePins: routines };
  });
  emitResourceChange(companyId, "employee");
  if (result.clearedRoutinePins > 0) emitResourceChange(companyId, "routine");
  return result;
}

/**
 * Make an attached model the employee's active one. False when the model is
 * not attached to the employee (or either is not in this company).
 */
export async function setActiveModel(
  companyId: string,
  employeeId: string,
  modelId: string,
): Promise<boolean> {
  const done = await withSerializedTransaction(async (manager) => {
    const [employee] = await lockEmployees(manager, companyId, [employeeId]);
    if (!employee) return false;
    const target = await manager
      .getRepository(EmployeeModel)
      .findOneBy({ employeeId, modelId, companyId });
    if (!target) return false;
    await flipActive(manager, employeeId, modelId);
    return true;
  });
  if (done) emitResourceChange(companyId, "employee");
  return done;
}

/** One AI Employee using a model, as the model's card lists them. */
export type ModelUser = {
  id: string;
  name: string;
  slug: string;
  avatarKey: string | null;
  /** Whether this model is that employee's active one. */
  isActive: boolean;
};

/**
 * Who uses each of a company's AI Models — the employees it is attached to,
 * in name order, and whether it is each one's active model. One indexed read
 * of the company's attachments and one of its employees.
 */
export async function modelUsers(
  companyId: string,
  manager: EntityManager = AppDataSource.manager,
): Promise<Map<string, ModelUser[]>> {
  const rows = await manager.getRepository(EmployeeModel).find({ where: { companyId } });
  const users = new Map<string, ModelUser[]>();
  if (rows.length === 0) return users;
  const employees = await manager.getRepository(AIEmployee).find({
    where: { companyId, id: In([...new Set(rows.map((row) => row.employeeId))]) },
    select: { id: true, name: true, slug: true, avatarKey: true },
  });
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const rowsByEmployee = new Map<string, EmployeeModel[]>();
  for (const row of rows) {
    if (!employeeById.has(row.employeeId)) continue;
    const list = rowsByEmployee.get(row.employeeId);
    if (list) list.push(row);
    else rowsByEmployee.set(row.employeeId, [row]);
  }
  for (const [employeeId, list] of rowsByEmployee) {
    const employee = employeeById.get(employeeId)!;
    const activeId = effectiveActiveId(attachmentShapes(list));
    for (const row of list) {
      const entry: ModelUser = {
        id: employee.id,
        name: employee.name,
        slug: employee.slug,
        avatarKey: employee.avatarKey ?? null,
        isActive: row.modelId === activeId,
      };
      const existing = users.get(row.modelId);
      if (existing) existing.push(entry);
      else users.set(row.modelId, [entry]);
    }
  }
  for (const list of users.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  return users;
}

/** Remove every attachment of `employeeIds` — they are leaving the company. */
export async function deleteEmployeeAttachments(
  employeeIds: readonly string[],
  manager: EntityManager = AppDataSource.manager,
): Promise<void> {
  if (employeeIds.length === 0) return;
  await manager.getRepository(EmployeeModel).delete({ employeeId: In([...employeeIds]) });
}
