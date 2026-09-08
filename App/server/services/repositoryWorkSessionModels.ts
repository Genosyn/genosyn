import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import type { Repository } from "../db/entities/Repository.js";
import { effectiveActiveId, resolveChatModel } from "./models.js";
import { isModelConnected, PROVIDERS } from "./providers.js";

/** Only employees granted this company's Repository, with credential-free model choices. */
export async function repositoryWorkSessionCandidates(repo: Repository) {
  const grants = await AppDataSource.getRepository(EmployeeRepositoryGrant).find({
    where: { repositoryId: repo.id },
  });
  const employees = grants.length
    ? await AppDataSource.getRepository(AIEmployee).find({
        where: { companyId: repo.companyId, id: In(grants.map((grant) => grant.employeeId)) },
        order: { createdAt: "ASC" },
      })
    : [];
  const models = employees.length
    ? await AppDataSource.getRepository(AIModel).find({
        where: { employeeId: In(employees.map((employee) => employee.id)) },
        order: { createdAt: "ASC", id: "ASC" },
      })
    : [];
  return employees.map((employee) => {
    const choices = models.filter((model) => model.employeeId === employee.id);
    const activeId = effectiveActiveId(choices);
    return {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
      avatarKey: employee.avatarKey ?? null,
      models: choices.map((model) => ({
        id: model.id,
        provider: model.provider,
        model: model.model,
        label: [PROVIDERS[model.provider].label, model.model].filter(Boolean).join(" · "),
        status: isModelConnected(model) ? ("connected" as const) : ("not_connected" as const),
        isActive: model.id === activeId,
      })),
    };
  });
}

/** An explicit choice must never silently fall back to a different model. */
export async function requireWorkSessionModel(
  employee: AIEmployee,
  modelId?: string | null,
): Promise<AIModel> {
  const model = await resolveChatModel(employee.id, modelId);
  if (!model) {
    throw new Error(
      modelId
        ? "The selected AI Model is no longer available for this employee. Start a new work session with an available model."
        : `${employee.name} has no AI Model connected yet.`,
    );
  }
  if (!isModelConnected(model)) {
    throw new Error("The selected AI Model is not connected. Connect it before starting work.");
  }
  return model;
}
