import { In, type QueryDeepPartialEntity } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";

/**
 * Fixtures for AI Models, which belong to the company and are attached to AI
 * Employees (`EmployeeModel`).
 *
 * `insertEmployeeModel` takes the shape a test has always written for "this
 * employee has a model" — `employeeId`, `isActive`, the model's own columns —
 * and saves what that means now: a company AI Model attached to the employee.
 * The company comes from the employee row, or from `companyId` when a test
 * never inserted the employee. `isActive` lands on the attachment and, like
 * the service, clears the employee's other active flag. The attachment takes
 * the model's `createdAt` (or `attachedAt`) at millisecond precision, kept
 * strictly increasing, so "the most recently attached" is never a tie.
 */

export type EmployeeModelFixture = Partial<Omit<AIModel, "companyId">> & {
  employeeId: string;
  isActive?: boolean;
  companyId?: string;
  /** When it was attached; defaults to the model's `createdAt`, else now. */
  attachedAt?: Date;
};

export type AttachedModelFixture = AIModel & { employeeId: string; isActive: boolean };

let lastAttachedAt = 0;

function attachmentTime(requested: Date | undefined): Date {
  if (requested) return requested;
  const now = Math.max(Date.now(), lastAttachedAt + 1);
  lastAttachedAt = now;
  return new Date(now);
}

async function companyOf(employeeId: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const employee = await AppDataSource.getRepository(AIEmployee).findOne({
    where: { id: employeeId },
    select: { id: true, companyId: true },
  });
  if (!employee) {
    throw new Error(
      `insertEmployeeModel: employee ${employeeId} does not exist — insert it first or pass companyId`,
    );
  }
  return employee.companyId;
}

/** Save a company AI Model attached to one employee. */
export async function insertEmployeeModel(
  values: EmployeeModelFixture,
): Promise<AttachedModelFixture> {
  const { employeeId, isActive = false, companyId: explicit, attachedAt, ...model } = values;
  const companyId = await companyOf(employeeId, explicit);
  const models = AppDataSource.getRepository(AIModel);
  const saved = await models.save(models.create({ ...model, companyId }));
  await attachExistingModel({
    employeeId,
    modelId: saved.id,
    companyId,
    isActive,
    attachedAt: attachedAt ?? model.createdAt,
  });
  return Object.assign(saved, { employeeId, isActive });
}

/** Attach an existing company model to another employee, as the service would. */
export async function attachExistingModel(values: {
  employeeId: string;
  modelId: string;
  companyId?: string;
  isActive?: boolean;
  attachedAt?: Date;
}): Promise<EmployeeModel> {
  const companyId = await companyOf(values.employeeId, values.companyId);
  const attachments = AppDataSource.getRepository(EmployeeModel);
  if (values.isActive) {
    await attachments.update({ employeeId: values.employeeId }, { isActive: false });
  }
  return attachments.save(
    attachments.create({
      companyId,
      employeeId: values.employeeId,
      modelId: values.modelId,
      isActive: values.isActive ?? false,
      createdAt: attachmentTime(values.attachedAt),
    }),
  );
}

/** The ids of the models attached to an employee, oldest attachment first. */
export async function attachedModelIds(employeeId: string): Promise<string[]> {
  const rows = await AppDataSource.getRepository(EmployeeModel).find({
    where: { employeeId },
    order: { createdAt: "ASC", id: "ASC" },
  });
  return rows.map((row) => row.modelId);
}

/** The model an employee's attachment flags active, or null. */
export async function flaggedActiveModel(employeeId: string): Promise<AIModel | null> {
  const row = await AppDataSource.getRepository(EmployeeModel).findOneBy({
    employeeId,
    isActive: true,
  });
  return row ? AppDataSource.getRepository(AIModel).findOneBy({ id: row.modelId }) : null;
}

/** The models attached to an employee, oldest attachment first. */
export async function modelsOf(employeeId: string): Promise<AIModel[]> {
  const ids = await attachedModelIds(employeeId);
  if (ids.length === 0) return [];
  const rows = await AppDataSource.getRepository(AIModel).findBy({ id: In(ids) });
  return ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is AIModel => !!row);
}

/** The model an employee's attachment flags active; throws when there is none. */
export async function activeModelOf(employeeId: string): Promise<AIModel> {
  const model = await flaggedActiveModel(employeeId);
  if (!model) throw new Error(`employee ${employeeId} has no active AI Model attached`);
  return model;
}

/** Update every model attached to an employee — the old update by `employeeId`. */
export async function updateModelsOf(
  employeeId: string,
  values: QueryDeepPartialEntity<AIModel>,
): Promise<void> {
  const ids = await attachedModelIds(employeeId);
  if (ids.length > 0) await AppDataSource.getRepository(AIModel).update({ id: In(ids) }, values);
}

/** Detach every model from an employee — the old "delete its models" in tests. */
export async function detachAllModels(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeModel).delete({ employeeId });
}
