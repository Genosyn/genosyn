import { createHash } from "node:crypto";
import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { withSerializedTransaction } from "../../db/transactions.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { Company } from "../../db/entities/Company.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Repository } from "../../db/entities/Repository.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { Routine } from "../../db/entities/Routine.js";
import { RoutineTrigger } from "../../db/entities/RoutineTrigger.js";
import { effectiveActiveId } from "../models.js";
import { isModelConnected } from "../providers.js";
import { recordAudit } from "../audit.js";
import { assertRoutineCapacity } from "../entitlements.js";
import { nextRunFor } from "../cron.js";
import { emitResourceChange } from "../resourceEvents.js";
import { broadcastToCompany } from "../realtime.js";
import { parseActions, parseConditions } from "../mail/rules.js";
import { PROACTIVE_RECIPES, PROACTIVE_WORK_GUIDANCE } from "./catalogue.js";
import {
  proactiveReadiness,
  type ProactiveInstallation,
  type ProactiveOverview,
  type ProactiveRecipe,
} from "../../../shared/proactive.js";

export class ProactiveSetupError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Native rows remain the source of truth. A stable primary key makes retries
 * and concurrent installs converge without a second automation registry. */
export function proactiveId(
  companyId: string,
  employeeId: string,
  recipeId: string,
  accountId: string | null,
): string {
  const hex = createHash("sha1")
    .update(JSON.stringify(["genosyn-proactive-v1", companyId, employeeId, recipeId, accountId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function getProactiveOverview(companyId: string): Promise<ProactiveOverview> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!company) throw new ProactiveSetupError("Company not found", 404);
  const [roster, accounts, finance, revenue, repositories, calendars] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({ where: { companyId }, order: { name: "ASC" } }),
    AppDataSource.getRepository(MailAccount).find({
      where: { companyId },
      order: { address: "ASC" },
    }),
    AppDataSource.getRepository(EmployeeFinanceGrant).findBy({ companyId }),
    AppDataSource.getRepository(EmployeeRevenueGrant).findBy({ companyId }),
    AppDataSource.getRepository(Repository).findBy({ companyId }),
    AppDataSource.getRepository(CalendarAccount).findBy({ companyId }),
  ]);
  const employeeIds = roster.map((employee) => employee.id);
  const [models, mailGrants, repositoryGrants, calendarGrants, rules, routines] = employeeIds.length
    ? await Promise.all([
        AppDataSource.getRepository(AIModel).findBy({ employeeId: In(employeeIds) }),
        AppDataSource.getRepository(EmployeeMailAccountGrant).findBy({
          employeeId: In(employeeIds),
        }),
        AppDataSource.getRepository(EmployeeRepositoryGrant).findBy({
          employeeId: In(employeeIds),
        }),
        AppDataSource.getRepository(EmployeeCalendarGrant).findBy({ employeeId: In(employeeIds) }),
        AppDataSource.getRepository(MailRule).findBy({ companyId }),
        AppDataSource.getRepository(Routine).findBy({ employeeId: In(employeeIds) }),
      ])
    : [[], [], [], [], [], []];
  const accountIds = new Set(accounts.map((account) => account.id));
  const repositoryIds = new Set(repositories.map((repository) => repository.id));
  const calendarIds = new Set(calendars.map((calendar) => calendar.id));
  const employees = roster.map((employee) => {
    const brains = models.filter((model) => model.employeeId === employee.id);
    const active = brains.find((model) => model.id === effectiveActiveId(brains));
    return {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      modelReady: Boolean(active && isModelConnected(active)),
      financeAccess: finance.find((grant) => grant.employeeId === employee.id)?.accessLevel ?? null,
      revenueAccess: revenue.find((grant) => grant.employeeId === employee.id)?.accessLevel ?? null,
      repositoryWrite: repositoryGrants.some(
        (grant) =>
          grant.employeeId === employee.id &&
          repositoryIds.has(grant.repositoryId) &&
          grant.accessLevel === "write",
      ),
      calendarRead: calendarGrants.some(
        (grant) => grant.employeeId === employee.id && calendarIds.has(grant.accountId),
      ),
      mailGrants: mailGrants
        .filter((grant) => grant.employeeId === employee.id && accountIds.has(grant.accountId))
        .map(({ accountId, accessLevel }) => ({ accountId, accessLevel })),
    };
  });
  const installations: ProactiveInstallation[] = [];
  const byRule = new Map(rules.map((rule) => [rule.id, rule]));
  const byRoutine = new Map(routines.map((routine) => [routine.id, routine]));
  for (const employee of employees) {
    for (const recipe of PROACTIVE_RECIPES) {
      const scopes = recipe.requirements.includes("mail")
        ? accounts.map((account) => account.id)
        : [null];
      for (const accountId of scopes) {
        const id = proactiveId(companyId, employee.id, recipe.id, accountId);
        const row = recipe.kind === "email" ? byRule.get(id) : byRoutine.get(id);
        if (!row) continue;
        // Native editors remain authoritative. Do not attribute a rule that
        // somebody reassigned to this employee's starter merely by its old id.
        if (
          row instanceof MailRule &&
          !parseActions(row.actionsJson).some(
            (action) => action.type === "handToEmployee" && action.employeeId === employee.id,
          )
        )
          continue;
        installations.push({
          id,
          recipeId: recipe.id,
          employeeId: employee.id,
          accountId,
          name: row.name,
          kind: recipe.kind,
          enabled: row.enabled,
          delivery:
            row instanceof MailRule &&
            parseActions(row.actionsJson).some(
              (action) => action.type === "handToEmployee" && action.mode === "reply",
            )
              ? "soul"
              : "draft",
          href:
            row instanceof Routine
              ? `/c/${company.slug}/routines/${employee.slug}/${row.slug}`
              : `/c/${company.slug}/mail/rules?account=${accountId}`,
        });
      }
    }
  }
  // A mailbox can be deleted after a scheduled starter was created. Keep
  // its persisted, restricted Routine visible so it can still be paused and
  // reviewed; listing must not make active work disappear with its source.
  for (const routine of routines) {
    if (routine.mailDeliveryMode == null || installations.some((entry) => entry.id === routine.id))
      continue;
    const employee = employees.find((entry) => entry.id === routine.employeeId)!;
    const recipe = PROACTIVE_RECIPES.find((entry) =>
      routine.slug.startsWith(`proactive-${entry.id}-`),
    );
    installations.push({
      id: routine.id,
      recipeId: recipe?.id ?? "custom",
      employeeId: employee.id,
      accountId: null,
      name: routine.name,
      kind: "routine",
      enabled: routine.enabled,
      delivery: "draft",
      href: `/c/${company.slug}/routines/${employee.slug}/${routine.slug}`,
      configurationIssue:
        "The original setup could not be resolved. Review this Routine and its source resources before resuming.",
    });
  }
  return {
    recipes: PROACTIVE_RECIPES.map((recipe) => ({
      ...recipe,
      brief: `${recipe.brief}\n\n${PROACTIVE_WORK_GUIDANCE}`,
    })),
    employees,
    mailboxes: accounts.map((account) => ({
      id: account.id,
      address: account.address,
      status: account.status,
      analysisEnabled: account.aiAnalysisEnabled,
    })),
    installations,
  };
}

export type ProactiveSetupInput = {
  recipeId: string;
  employeeId: string;
  accountId?: string | null;
  delivery: "draft" | "soul";
  instruction: string;
};

function validateSetup(overview: ProactiveOverview, input: ProactiveSetupInput): ProactiveRecipe {
  const recipe = overview.recipes.find((entry) => entry.id === input.recipeId);
  if (!recipe) throw new ProactiveSetupError("Starter not found", 404);
  if (!recipe.requirements.includes("mail") && input.accountId)
    throw new ProactiveSetupError("This starter does not use a mailbox.");
  if (recipe.kind === "routine" && input.delivery !== "draft")
    throw new ProactiveSetupError(
      "Scheduled starters prepare drafts; configure further authority on the Routine after review.",
    );
  const employee = overview.employees.find((entry) => entry.id === input.employeeId);
  if (!employee) throw new ProactiveSetupError("AI Employee not found", 404);
  const mailbox = overview.mailboxes.find((entry) => entry.id === input.accountId);
  if (input.accountId && !mailbox) throw new ProactiveSetupError("Mailbox not found", 404);
  const missing = proactiveReadiness(recipe, employee, mailbox, input.delivery);
  if (missing.length) throw new ProactiveSetupError(missing.join(" "));
  return recipe;
}

export async function installProactiveStarter(
  companyId: string,
  userId: string,
  input: ProactiveSetupInput,
): Promise<ProactiveInstallation> {
  const overview = await getProactiveOverview(companyId);
  const recipe = validateSetup(overview, input);
  const accountId = input.accountId ?? null;
  const id = proactiveId(companyId, input.employeeId, recipe.id, accountId);
  const existing = overview.installations.find((entry) => entry.id === id);
  // Retried requests never change the instruction or re-enable paused work.
  if (existing) return existing;
  if (!input.instruction.trim() || input.instruction.length > 20_000)
    throw new ProactiveSetupError("Provide instructions of 1–20,000 characters.");
  const mailbox = overview.mailboxes.find((account) => account.id === accountId);
  const body = `${input.instruction.trim()}${mailbox ? `\n\nAssigned mailbox: ${JSON.stringify({ accountId: mailbox.id, address: mailbox.address })}. Use this mailbox only for this starter.` : ""}`;
  try {
    const created = await withSerializedTransaction(async (manager) => {
      if (AppDataSource.options.type === "postgres")
        await manager
          .getRepository(Company)
          .findOneOrFail({ where: { id: companyId }, lock: { mode: "pessimistic_write" } });
      const occupied =
        recipe.kind === "email"
          ? await manager.getRepository(MailRule).existsBy({ id })
          : await manager.getRepository(Routine).existsBy({ id });
      if (occupied) return false;
      if (recipe.kind === "routine") await assertRoutineCapacity(companyId);
      if (recipe.kind === "email") {
        await manager.getRepository(MailRule).insert({
          id,
          companyId,
          accountId: accountId!,
          name: recipe.name,
          enabled: true,
          createdByUserId: userId,
          conditionsJson: JSON.stringify({ category: recipe.category }),
          actionsJson: JSON.stringify([
            {
              type: "handToEmployee",
              employeeId: input.employeeId,
              mode: input.delivery === "soul" ? "reply" : "work",
              instruction: body,
            },
          ]),
        });
      } else {
        await manager.getRepository(Routine).insert({
          id,
          employeeId: input.employeeId,
          name: recipe.name,
          slug: `proactive-${recipe.id}-${id.slice(0, 8)}`,
          enabled: true,
          cronExpr: recipe.schedule!,
          nextRunAt: nextRunFor(recipe.schedule!),
          body,
          acceptanceCriteria: recipe.acceptanceCriteria,
          mailDeliveryMode: "draft",
        });
        if (recipe.triggerKind)
          await manager.getRepository(RoutineTrigger).insert({
            id: proactiveId(companyId, input.employeeId, `${recipe.id}:trigger`, accountId),
            companyId,
            routineId: id,
            kind: recipe.triggerKind,
            enabled: true,
            minIntervalSec: 3600,
          });
      }
      return true;
    });
    if (!created) {
      const installed = (await getProactiveOverview(companyId)).installations.find(
        (entry) => entry.id === id,
      );
      if (!installed)
        throw new ProactiveSetupError(
          "This starter was customized. Review its existing configuration before enabling it.",
          409,
        );
      return installed;
    }
  } catch (error) {
    // A concurrent insert may have won the primary key. Read back its exact
    // result; unrelated database failures must still reach the caller.
    const raced = (await getProactiveOverview(companyId)).installations.find(
      (entry) => entry.id === id,
    );
    if (raced) return raced;
    throw error;
  }
  await recordAudit({
    companyId,
    actorUserId: userId,
    action: "proactive.enable",
    targetType: recipe.kind === "email" ? "mail_rule" : "routine",
    targetId: id,
    targetLabel: recipe.name,
    metadata: {
      recipeId: recipe.id,
      employeeId: input.employeeId,
      accountId,
      delivery: input.delivery,
    },
  });
  changed(companyId, recipe.kind, accountId);
  return (await getProactiveOverview(companyId)).installations.find((entry) => entry.id === id)!;
}

export async function toggleProactiveStarter(
  companyId: string,
  userId: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const overview = await getProactiveOverview(companyId);
  const installation = overview.installations.find((entry) => entry.id === id);
  if (!installation) throw new ProactiveSetupError("Installed starter not found", 404);
  if (enabled && installation.configurationIssue)
    throw new ProactiveSetupError(installation.configurationIssue);
  if (enabled)
    validateSetup(overview, { ...installation, delivery: installation.delivery, instruction: "" });
  if (installation.kind === "email") {
    const rule = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id, companyId });
    // If the native editor changed matching or the employee, don't silently
    // restore an old category when resuming it here.
    if (
      enabled &&
      parseConditions(rule.conditionsJson).category !==
        overview.recipes.find((recipe) => recipe.id === installation.recipeId)?.category
    )
      throw new ProactiveSetupError(
        "This rule was customized. Review and enable it from Email → Rules.",
      );
    await AppDataSource.getRepository(MailRule).update({ id, companyId }, { enabled });
  } else {
    const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id,
      employeeId: installation.employeeId,
    });
    await AppDataSource.getRepository(Routine).update(
      { id, employeeId: installation.employeeId },
      { enabled, nextRunAt: enabled ? nextRunFor(routine.cronExpr) : null },
    );
  }
  await recordAudit({
    companyId,
    actorUserId: userId,
    action: enabled ? "proactive.resume" : "proactive.pause",
    targetType: installation.kind === "email" ? "mail_rule" : "routine",
    targetId: id,
    targetLabel: installation.name,
  });
  changed(companyId, installation.kind, installation.accountId);
}

function changed(companyId: string, kind: "email" | "routine", accountId: string | null): void {
  if (kind === "email" && accountId)
    broadcastToCompany(companyId, { type: "mail.updated", accountId });
  else emitResourceChange(companyId, "routine");
}
