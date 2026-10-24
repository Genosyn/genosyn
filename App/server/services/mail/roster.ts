import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import {
  EmployeeMailAccountGrant,
  type MailAccessLevel,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { attachedModelsByEmployee } from "../models.js";
import { isModelConnected } from "../providers.js";

/**
 * Every AI Employee in the company as one mailbox sees them: the Grant each
 * holds on it and the AI Models each could answer on. The mailbox's AI triage
 * settings use it to offer a reader and a model honestly — a grayed-out
 * employee beats a setting that silently fails.
 *
 * Chat about an email lives in Ask AI now (`services/askAi/`), which applies
 * the same mailbox Grant per employee to the thread on screen.
 */

/** One brain an employee could run a mailbox's AI work on. */
export type MailboxModelOption = {
  id: string;
  provider: AIModel["provider"];
  model: string;
  isActive: boolean;
};

export type MailboxRosterEntry = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  accessLevel: MailAccessLevel | null;
  hasModel: boolean;
  /**
   * The employee's connected models, active first.
   * Only connected rows: an unconnected model can't answer, so offering it
   * would be an affordance that fails after the human commits to it.
   */
  models: MailboxModelOption[];
};

/**
 * Every AI employee in the company, annotated with their grant level on this
 * mailbox (null = no access), whether they have a model at all, and which
 * models work can be sent to.
 */
export async function mailboxRoster(
  companyId: string,
  accountId: string,
): Promise<MailboxRosterEntry[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    order: { name: "ASC" },
  });
  if (employees.length === 0) return [];
  const ids = employees.map((e) => e.id);
  const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
    where: { accountId, employeeId: In(ids) },
  });
  // Any attached model counts for `hasModel`: getActiveModel falls back to
  // the newest attachment when none is flagged active, so "has one attached"
  // is what the chat seam resolves. The picker is stricter — see `models`.
  const attached = await attachedModelsByEmployee(ids);
  const grantByEmp = new Map(grants.map((g) => [g.employeeId, g.accessLevel]));
  const modeled = new Set<string>();
  const optionsByEmp = new Map<string, MailboxModelOption[]>();
  for (const [employeeId, { models, activeId }] of attached) {
    if (models.length > 0) modeled.add(employeeId);
    // Active first: it is the one a turn runs on unless the human says
    // otherwise, so it belongs at the top of the picker. Most recently
    // attached breaks the tie.
    const options = models
      .filter((model) => isModelConnected(model))
      .map((model) => ({
        id: model.id,
        provider: model.provider,
        model: model.model,
        isActive: model.id === activeId,
      }))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive));
    optionsByEmp.set(employeeId, options);
  }
  return employees.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    role: e.role,
    avatarKey: e.avatarKey ?? null,
    accessLevel: grantByEmp.get(e.id) ?? null,
    hasModel: modeled.has(e.id),
    models: optionsByEmp.get(e.id) ?? [],
  }));
}
