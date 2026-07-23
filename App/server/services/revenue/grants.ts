import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import {
  EmployeeRevenueGrant,
  REVENUE_ACCESS_RANK,
  type RevenueAccessLevel,
} from "../../db/entities/EmployeeRevenueGrant.js";

/**
 * The revenue grant is the AI-side gate for the whole Revenue section —
 * contacts, deals, activities, sequences, signals and the revenue reports.
 * Humans authorize an employee from **Revenue → AI access**; the MCP revenue
 * tools then answer to the level stored here. Members bypass it entirely; this
 * governs only the AI surface.
 *
 * One row per employee, mirroring the finance grant: revenue is a single
 * company-wide subsystem rather than a set of individually-shared rows like
 * mailboxes or resources.
 */

export type HydratedRevenueGrant = {
  id: string;
  employeeId: string;
  accessLevel: RevenueAccessLevel;
  createdAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  } | null;
};

export async function getRevenueGrant(
  employeeId: string,
): Promise<EmployeeRevenueGrant | null> {
  return AppDataSource.getRepository(EmployeeRevenueGrant).findOneBy({ employeeId });
}

/**
 * True when the employee holds a revenue grant at or above `required`. A single
 * integer `>=` on the rank map, exactly like `hasFinanceAccess`.
 */
export async function hasRevenueAccess(
  employeeId: string,
  required: RevenueAccessLevel,
): Promise<boolean> {
  const grant = await getRevenueGrant(employeeId);
  if (!grant) return false;
  return REVENUE_ACCESS_RANK[grant.accessLevel] >= REVENUE_ACCESS_RANK[required];
}

/** Create or move an employee's revenue grant to `level`. Idempotent. */
export async function upsertRevenueGrant(
  companyId: string,
  employeeId: string,
  level: RevenueAccessLevel,
): Promise<EmployeeRevenueGrant> {
  const repo = AppDataSource.getRepository(EmployeeRevenueGrant);
  let grant = await repo.findOneBy({ employeeId });
  if (grant) {
    grant.accessLevel = level;
    grant.companyId = companyId;
  } else {
    grant = repo.create({ companyId, employeeId, accessLevel: level });
  }
  return repo.save(grant);
}

function hydrate(
  grants: EmployeeRevenueGrant[],
  employees: Map<string, AIEmployee>,
): HydratedRevenueGrant[] {
  return grants.map((g) => {
    const emp = employees.get(g.employeeId);
    return {
      id: g.id,
      employeeId: g.employeeId,
      accessLevel: g.accessLevel,
      createdAt: g.createdAt.toISOString(),
      employee: emp
        ? {
            id: emp.id,
            name: emp.name,
            slug: emp.slug,
            role: emp.role,
            avatarKey: emp.avatarKey,
          }
        : null,
    };
  });
}

/** Every revenue grant in the company, employee-hydrated, oldest first. */
export async function listRevenueGrants(
  companyId: string,
): Promise<HydratedRevenueGrant[]> {
  const grants = await AppDataSource.getRepository(EmployeeRevenueGrant).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return [];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(grants.map((g) => g.employeeId)) },
  });
  return hydrate(grants, new Map(emps.map((e) => [e.id, e])));
}

export type RevenueGrantCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  alreadyGranted: boolean;
};

/** All company AI employees, each flagged whether it already has revenue access. */
export async function listRevenueGrantCandidates(
  companyId: string,
): Promise<RevenueGrantCandidate[]> {
  const [employees, grants] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId },
      order: { name: "ASC" },
    }),
    AppDataSource.getRepository(EmployeeRevenueGrant).find({ where: { companyId } }),
  ]);
  const granted = new Set(grants.map((g) => g.employeeId));
  return employees.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    role: e.role,
    avatarKey: e.avatarKey,
    alreadyGranted: granted.has(e.id),
  }));
}

/** Revoke a grant by id, scoped to the company. Returns null if not found. */
export async function deleteRevenueGrant(
  companyId: string,
  id: string,
): Promise<EmployeeRevenueGrant | null> {
  const repo = AppDataSource.getRepository(EmployeeRevenueGrant);
  const grant = await repo.findOneBy({ id, companyId });
  if (!grant) return null;
  await repo.delete({ id: grant.id });
  return grant;
}

const REVENUE_LEVEL_BLURB: Record<RevenueAccessLevel, string> = {
  read: "You can read the revenue system: list and open contacts and deals, read activity timelines, see sequences and signals, and pull revenue reports. You cannot change anything.",
  write:
    "You can work the pipeline: create and update contacts and deals, move a deal between stages, log activities, and enroll a contact in a sequence. Moving a deal into a won or lost stage closes it — do that deliberately. Every write you make is recorded against your name in the audit log.",
  send: "You have full revenue access: everything `write` allows, plus your sequence drafts may go out without a human pressing Send — but only for sequences explicitly marked auto-send, and only where you also hold `send` on the mailbox. Suppression, send windows and daily caps still apply to you; there is no way to bypass them, and you should not try.",
};

/**
 * A ready-made markdown section telling the employee it has revenue access, at
 * what level, and what that permits. Injected into the chat / routine prompt
 * next to the Finance context. Returns "" when the employee holds no grant, so
 * nothing is injected for employees without access.
 */
export async function composeRevenueContext(employeeId: string): Promise<string> {
  const grant = await getRevenueGrant(employeeId);
  if (!grant) return "";
  return [
    "",
    "## Revenue",
    `You have been granted **${grant.accessLevel}** access to the company's revenue system — contacts, deals, activities, sequences and signals. Find the tools with \`find_tools\` (search "contact", "deal", "pipeline", or "sequence").`,
    REVENUE_LEVEL_BLURB[grant.accessLevel],
    "A Contact is a person; a Customer is the billable account they may or may not belong to yet. A Deal is one opportunity, and its status always follows the stage it sits in. Money is integer minor units (cents) with a 3-letter ISO currency code.",
    "Before emailing anyone, check they are not suppressed — an address that unsubscribed or bounced must never be mailed again, and the send will be refused if you try.",
  ].join("\n");
}
