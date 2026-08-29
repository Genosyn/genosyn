import type { RequestHandler } from "express";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Channel } from "../db/entities/Channel.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Project } from "../db/entities/Project.js";
import { Routine } from "../db/entities/Routine.js";
import { Todo } from "../db/entities/Todo.js";
import { billingEnabled } from "./billing/billingSettings.js";
import { PLANS, isPlanId, type PlanId } from "./billing/plans.js";
import { getInstanceLicense } from "./license.js";

/**
 * Entitlement resolution (M56) — the single source of truth for what a
 * company may do on this install.
 *
 * Three deployment shapes, one resolver:
 *  - instance billing ENABLED (Genosyn Cloud): the company's `CompanyBilling`
 *    row decides. No row, or a paid plan whose subscription status is not
 *    active, resolves to Free. Edition is `"cloud"`.
 *  - billing DISABLED + valid Enterprise license: edition `"enterprise"`,
 *    features on, limits unlimited.
 *  - billing DISABLED, no/invalid license: edition `"community"`, features
 *    off, limits unlimited — self-hosting never caps AI Employees or
 *    Routines.
 *
 * Every enforcement point (hire, routine creation, feature-gated routers)
 * funnels through the asserts below so the 402 message is written once.
 */

export type Edition = "cloud" | "community" | "enterprise";
export type FeatureKey = "sso" | "auditLog";

export type CompanyEntitlements = {
  edition: Edition;
  plan: PlanId | null;
  maxAiEmployees: number | null;
  maxRoutines: number | null;
  maxBases: number | null;
  maxBaseTables: number | null;
  maxChannels: number | null;
  maxProjects: number | null;
  maxTodos: number | null;
  features: { sso: boolean; auditLog: boolean };
};

/** A Plan limit or feature gate refused the action — routes map it to 402. */
export class PlanLimitError extends Error {
  constructor(
    message: string,
    public readonly feature?: string,
  ) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export const HIRE_LIMIT_MESSAGE =
  "Your Free plan includes 1 AI Employee. Upgrade to Growth to hire more.";
export const ROUTINE_LIMIT_MESSAGE =
  "Your Free plan includes 2 Routines. Upgrade to Growth for unlimited Routines.";
export const BASE_LIMIT_MESSAGE =
  "Your Free plan includes 1 Base. Upgrade to Growth for unlimited Bases.";
export const BASE_TABLE_LIMIT_MESSAGE =
  "Your Free plan includes 1 Base table. Upgrade to Growth for unlimited tables.";
export const CHANNEL_LIMIT_MESSAGE =
  "Your Free plan includes 3 Channels. Upgrade to Growth for unlimited Channels.";
export const PROJECT_LIMIT_MESSAGE =
  "Your Free plan includes 1 Project. Upgrade to Growth for unlimited Projects.";
export const TODO_LIMIT_MESSAGE =
  "Your Free plan includes 20 Todos. Upgrade to Growth for unlimited Todos.";

/** Subscription statuses that keep a paid plan's entitlements live. `past_due`
 * stays on deliberately — Stripe is still retrying the charge, and cutting SSO
 * off during a card hiccup punishes the wrong moment. */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function planFromRow(row: CompanyBilling | undefined | null): PlanId {
  if (!row || !isPlanId(row.plan)) return "free";
  if (row.plan === "free") return "free";
  // A paid plan only counts while its subscription is in good standing.
  if (!row.status || !ACTIVE_STATUSES.has(row.status)) return "free";
  return row.plan;
}

function cloudEntitlements(plan: PlanId): CompanyEntitlements {
  const def = PLANS[plan];
  return {
    edition: "cloud",
    plan,
    maxAiEmployees: def.maxAiEmployees,
    maxRoutines: def.maxRoutines,
    maxBases: def.maxBases,
    maxBaseTables: def.maxBaseTables,
    maxChannels: def.maxChannels,
    maxProjects: def.maxProjects,
    maxTodos: def.maxTodos,
    features: { ...def.features },
  };
}

function selfHostedEntitlements(licensed: boolean): CompanyEntitlements {
  return {
    edition: licensed ? "enterprise" : "community",
    plan: null,
    maxAiEmployees: null,
    maxRoutines: null,
    maxBases: null,
    maxBaseTables: null,
    maxChannels: null,
    maxProjects: null,
    maxTodos: null,
    features: { sso: licensed, auditLog: licensed },
  };
}

export async function getCompanyEntitlements(companyId: string): Promise<CompanyEntitlements> {
  if (!(await billingEnabled())) {
    const license = await getInstanceLicense();
    return selfHostedEntitlements(license.featureValid);
  }
  const row = await AppDataSource.getRepository(CompanyBilling).findOneBy({ companyId });
  return cloudEntitlements(planFromRow(row));
}

/**
 * Batch resolution for company list serializers — one `CompanyBilling` fetch
 * for the page instead of a row lookup per company. The instance-level
 * license/billing reads are memoized already.
 */
export async function entitlementsForCompanies(
  companyIds: string[],
): Promise<Map<string, CompanyEntitlements>> {
  const out = new Map<string, CompanyEntitlements>();
  if (companyIds.length === 0) return out;
  if (!(await billingEnabled())) {
    const license = await getInstanceLicense();
    const shared = selfHostedEntitlements(license.featureValid);
    for (const id of companyIds) out.set(id, { ...shared, features: { ...shared.features } });
    return out;
  }
  const rows = await AppDataSource.getRepository(CompanyBilling).find({
    where: { companyId: In(companyIds) },
  });
  const byCompany = new Map(rows.map((row) => [row.companyId, row]));
  for (const id of companyIds) {
    out.set(id, cloudEntitlements(planFromRow(byCompany.get(id))));
  }
  return out;
}

/** Throws {@link PlanLimitError} when hiring one more AI Employee would
 * exceed the company's plan. */
export async function assertCanHireAiEmployee(companyId: string): Promise<void> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxAiEmployees === null) return;
  const count = await AppDataSource.getRepository(AIEmployee).countBy({ companyId });
  if (count + 1 > entitlements.maxAiEmployees) {
    throw new PlanLimitError(HIRE_LIMIT_MESSAGE);
  }
}

/**
 * How many more Routines the company may create; null = unlimited. Routines
 * hang off employees, so the count goes through the company's employee ids
 * (the `routes/routines.ts` listing pattern).
 */
export async function routineCapacityRemaining(companyId: string): Promise<number | null> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxRoutines === null) return null;
  const employeeIds = (
    await AppDataSource.getRepository(AIEmployee).find({
      where: { companyId },
      select: { id: true },
    })
  ).map((e) => e.id);
  const count = employeeIds.length
    ? await AppDataSource.getRepository(Routine).countBy({ employeeId: In(employeeIds) })
    : 0;
  return Math.max(0, entitlements.maxRoutines - count);
}

/** Throws {@link PlanLimitError} when creating `adding` more Routines would
 * exceed the company's plan. */
export async function assertRoutineCapacity(companyId: string, adding = 1): Promise<void> {
  const remaining = await routineCapacityRemaining(companyId);
  if (remaining === null) return;
  if (adding > remaining) {
    throw new PlanLimitError(ROUTINE_LIMIT_MESSAGE);
  }
}

/** Throws {@link PlanLimitError} when creating one more Base would exceed the
 * company's plan. */
export async function assertCanCreateBase(companyId: string): Promise<void> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxBases === null) return;
  const count = await AppDataSource.getRepository(Base).countBy({ companyId });
  if (count + 1 > entitlements.maxBases) {
    throw new PlanLimitError(BASE_LIMIT_MESSAGE);
  }
}

/**
 * How many more Base tables the company may create; null = unlimited. Tables
 * hang off Bases, so the count goes through the company's Base ids. Archived
 * tables don't count — archiving frees capacity, like the listing counts.
 */
export async function baseTableCapacityRemaining(companyId: string): Promise<number | null> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxBaseTables === null) return null;
  const baseIds = (
    await AppDataSource.getRepository(Base).find({
      where: { companyId },
      select: { id: true },
    })
  ).map((b) => b.id);
  const count = baseIds.length
    ? await AppDataSource.getRepository(BaseTable).countBy({
        baseId: In(baseIds),
        archivedAt: IsNull(),
      })
    : 0;
  return Math.max(0, entitlements.maxBaseTables - count);
}

/** Throws {@link PlanLimitError} when creating `adding` more Base tables would
 * exceed the company's plan. */
export async function assertBaseTableCapacity(companyId: string, adding = 1): Promise<void> {
  const remaining = await baseTableCapacityRemaining(companyId);
  if (remaining === null) return;
  if (adding > remaining) {
    throw new PlanLimitError(BASE_TABLE_LIMIT_MESSAGE);
  }
}

/** Throws {@link PlanLimitError} when creating one more Channel would exceed
 * the company's plan. Only live public/private rooms count — never DMs (AI
 * Employees talk to humans through them), never archived channels. */
export async function assertCanCreateChannel(companyId: string): Promise<void> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxChannels === null) return;
  const count = await AppDataSource.getRepository(Channel).countBy({
    companyId,
    kind: In(["public", "private"]),
    archivedAt: IsNull(),
  });
  if (count + 1 > entitlements.maxChannels) {
    throw new PlanLimitError(CHANNEL_LIMIT_MESSAGE);
  }
}

/** Throws {@link PlanLimitError} when creating one more Project would exceed
 * the company's plan. */
export async function assertCanCreateProject(companyId: string): Promise<void> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxProjects === null) return;
  const count = await AppDataSource.getRepository(Project).countBy({ companyId });
  if (count + 1 > entitlements.maxProjects) {
    throw new PlanLimitError(PROJECT_LIMIT_MESSAGE);
  }
}

/**
 * How many more Todos the company may create; null = unlimited. Todos hang off
 * Projects, so the count goes through the company's Project ids. Every row
 * counts regardless of status — deleting a Todo is what frees capacity.
 */
export async function todoCapacityRemaining(companyId: string): Promise<number | null> {
  const entitlements = await getCompanyEntitlements(companyId);
  if (entitlements.maxTodos === null) return null;
  const projectIds = (
    await AppDataSource.getRepository(Project).find({
      where: { companyId },
      select: { id: true },
    })
  ).map((p) => p.id);
  const count = projectIds.length
    ? await AppDataSource.getRepository(Todo).countBy({ projectId: In(projectIds) })
    : 0;
  return Math.max(0, entitlements.maxTodos - count);
}

/** Throws {@link PlanLimitError} when creating `adding` more Todos would
 * exceed the company's plan. */
export async function assertTodoCapacity(companyId: string, adding = 1): Promise<void> {
  const remaining = await todoCapacityRemaining(companyId);
  if (remaining === null) return;
  if (adding > remaining) {
    throw new PlanLimitError(TODO_LIMIT_MESSAGE);
  }
}

/** The 402 copy for a gated feature, phrased for the install's edition. */
export function featureGateMessage(feature: FeatureKey, edition: Edition): string {
  const label = feature === "auditLog" ? "Audit log" : "SSO";
  return edition === "cloud"
    ? `${label} is available on the Scale plan.`
    : `${label} is available in Genosyn Enterprise.`;
}

/**
 * Express middleware for company-scoped routers: 402 unless the company's
 * plan/license includes `feature`. Assumes `requireCompanyMember` already ran
 * (the `:cid` param is trusted to be this company).
 */
export function requireCompanyFeature(feature: FeatureKey): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const companyId = (req.params as Record<string, string>).cid;
      const entitlements = await getCompanyEntitlements(companyId);
      if (!entitlements.features[feature]) {
        res.status(402).json({ error: featureGateMessage(feature, entitlements.edition) });
        return;
      }
      next();
    })().catch(next);
  };
}
