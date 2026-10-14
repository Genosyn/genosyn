import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Goal } from "../db/entities/Goal.js";
import type { Company } from "../db/entities/Company.js";

/**
 * Whether a mission and a vision are both written. Either one alone is not
 * direction, which is why this stays a pure check on the two fields.
 */
export function hasWrittenDirection(
  company: Pick<Company, "mission" | "vision"> | null | undefined,
): boolean {
  return Boolean(company?.mission?.trim() && company?.vision?.trim());
}

/**
 * Whether the company has written a Goal: an active Goal that sits at the top
 * of the tree. A sub-goal belongs to a Goal that is already there, and an
 * archived, achieved or missed one is no longer steering anything.
 *
 * One indexed existence query (`goals` is indexed on `companyId, status`), so
 * the hire gate and Home's setup banner can ask it on every request.
 */
export async function companyHasGoal(companyId: string): Promise<boolean> {
  return AppDataSource.getRepository(Goal).existsBy({
    companyId,
    status: "active",
    parentGoalId: IsNull(),
  });
}

/**
 * The Goal the company steers by: its oldest active Goal at the top of the
 * tree. It is the one {@link companyHasGoal} counts, and the one the setup
 * guide quotes in the starter Routines it suggests.
 */
export async function primaryGoal(companyId: string): Promise<Goal | null> {
  return AppDataSource.getRepository(Goal).findOne({
    where: { companyId, status: "active", parentGoalId: IsNull() },
    order: { createdAt: "ASC", id: "ASC" },
  });
}

/**
 * {@link companyHasGoal} for many companies at once, for the Member's company
 * list: one query however many companies they belong to.
 */
export async function companyIdsWithGoal(companyIds: readonly string[]): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  const rows = await AppDataSource.getRepository(Goal).find({
    where: { companyId: In([...companyIds]), status: "active", parentGoalId: IsNull() },
    select: { companyId: true },
  });
  return new Set(rows.map((row) => row.companyId));
}

/**
 * Company direction is required before the next AI Employee is hired, and the
 * rule is the same at every gate: an active top-level Goal, or a mission and a
 * vision. The Goal is what a new company is asked for; the pair stays valid so
 * companies that wrote it earlier are not sent back to a step they finished.
 */
export async function hasCompanyDirection(
  company: Pick<Company, "id" | "mission" | "vision"> | null | undefined,
): Promise<boolean> {
  if (!company) return false;
  if (hasWrittenDirection(company)) return true;
  return companyHasGoal(company.id);
}

/** What a refused hire says, in one place so the route and its tests agree. */
export const COMPANY_DIRECTION_REQUIRED = "Set your company's Goal before hiring an AI Employee.";
