import { In, type EntityManager } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { withSerializedTransaction } from "../../db/transactions.js";
import { Company } from "../../db/entities/Company.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { Routine } from "../../db/entities/Routine.js";
import { parseActions, parseConditions } from "../mail/rules.js";
import { PROACTIVE_RECIPES } from "./catalogue.js";
import { proactiveScope } from "./scopes.js";
import { proactiveId } from "./ids.js";

const stateSchema = z
  .object({
    version: z.literal(1),
    assignments: z.record(z.string().uuid()),
  })
  .strict();
export type ProactiveDefaultsState = z.infer<typeof stateSchema>;

/** Reservations only. Instructions, scheduling, enabled state and authority
 * remain on the native rows. Keeping a reservation after deletion respects
 * the Member's choice instead of recreating their work on the next sweep. */
export function readProactiveDefaults(raw: string): ProactiveDefaultsState {
  if (!raw) return { version: 1, assignments: {} };
  try {
    return stateSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Automatic setup could not read its saved assignments.");
  }
}

export async function lockProactiveCompany(
  manager: EntityManager,
  companyId: string,
): Promise<Company> {
  return manager.getRepository(Company).findOneOrFail({
    where: { id: companyId },
    ...(AppDataSource.options.type === "postgres"
      ? { lock: { mode: "pessimistic_write" as const } }
      : {}),
  });
}

/** Called inside the same company transaction as installing work. It also
 * adopts recognizable native edits made between reconciliation passes. */
export async function collectProactiveDefaults(
  manager: EntityManager,
  company: Company,
): Promise<ProactiveDefaultsState> {
  const state = readProactiveDefaults(company.proactiveDefaultsJson);
  const reserve = (recipeId: string, employeeId: string, accountId: string | null, id: string) => {
    const scope = proactiveScope(recipeId, accountId, employeeId);
    state.assignments[scope] ??= id;
  };

  // Upgrade bridge only: preserve installations removed before reservations
  // existed. Subsequent passes use the durable state, never audit retention.
  if (!company.proactiveDefaultsJson) {
    const receipts = await manager.getRepository(AuditEvent).find({
      where: { companyId: company.id, action: "proactive.enable" },
      order: { createdAt: "ASC", id: "ASC" },
    });
    const receiptSchema = z.object({
      recipeId: z.string(),
      employeeId: z.string().uuid(),
      accountId: z.string().uuid().nullable(),
    });
    for (const receipt of receipts) {
      if (!receipt.targetId || !z.string().uuid().safeParse(receipt.targetId).success) continue;
      try {
        const metadata = receiptSchema.parse(JSON.parse(receipt.metadataJson));
        const recipe = PROACTIVE_RECIPES.find((entry) => entry.id === metadata.recipeId);
        if (!recipe || recipe.requirements.includes("mail") !== Boolean(metadata.accountId))
          continue;
        reserve(recipe.id, metadata.employeeId, metadata.accountId, receipt.targetId);
      } catch {
        // Older/unrelated receipts are not an assignment record.
      }
    }
  }

  const rules = await manager.getRepository(MailRule).find({
    where: { companyId: company.id },
    order: { createdAt: "ASC", id: "ASC" },
  });
  for (const rule of rules) {
    const recipe = PROACTIVE_RECIPES.find(
      (entry) =>
        entry.kind === "email" && entry.category === parseConditions(rule.conditionsJson).category,
    );
    const action = parseActions(rule.actionsJson).find((entry) => entry.type === "handToEmployee");
    if (recipe && action?.type === "handToEmployee")
      reserve(recipe.id, action.employeeId, rule.accountId, rule.id);
  }
  const employees = await manager.getRepository(AIEmployee).findBy({ companyId: company.id });
  const accounts = await manager.getRepository(MailAccount).findBy({ companyId: company.id });
  const routines = employees.length
    ? await manager
        .getRepository(Routine)
        .findBy({ employeeId: In(employees.map((entry) => entry.id)) })
    : [];
  for (const routine of routines) {
    const recipe = PROACTIVE_RECIPES.find(
      (entry) => entry.kind === "routine" && routine.slug.startsWith(`proactive-${entry.id}-`),
    );
    // Company/employee responsibilities do not need their original mailbox
    // to reserve their scope. Mailbox-scoped receipts were adopted above.
    if (!recipe) continue;
    if (recipe.id !== "customer-commitments")
      reserve(recipe.id, routine.employeeId, null, routine.id);
    else {
      const account = accounts.find(
        (entry) => proactiveId(company.id, routine.employeeId, recipe.id, entry.id) === routine.id,
      );
      if (account) reserve(recipe.id, routine.employeeId, account.id, routine.id);
    }
  }
  return state;
}

export async function initializeProactiveDefaults(companyId: string): Promise<void> {
  await withSerializedTransaction(async (manager) => {
    const company = await lockProactiveCompany(manager, companyId);
    const state = await collectProactiveDefaults(manager, company);
    const json = JSON.stringify(state);
    if (json !== company.proactiveDefaultsJson)
      await manager
        .getRepository(Company)
        .update({ id: companyId }, { proactiveDefaultsJson: json });
  });
}
