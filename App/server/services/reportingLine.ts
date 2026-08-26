import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";

/**
 * Who an AI Employee answers to.
 *
 * `AIEmployee.reportsToEmployeeId` and `reportsToUserId` are mutually
 * exclusive (routes/employees.ts clears one when the other is set), so a
 * reporting line is a single chain: zero or more AI Employees ending, at most
 * once, at one human Member. Oversight features ask this module "is this
 * Member accountable for that employee's work?" instead of each re-walking
 * the org chart — and re-deriving the cycle guard that walk needs.
 */

/** Depth cap. A company that nests employees deeper than this has a cycle. */
const MAX_REPORTING_DEPTH = 64;

/**
 * The Member an employee ultimately reports to, or null when the chain ends
 * at an employee with no manager. Walks upward through AI managers, so an
 * employee reporting to a lead who reports to a human resolves to that human.
 *
 * The final pointer is confirmed against a live `Membership` before it is
 * returned. `reportsToUserId` is only ever *set* to a validated Member, but
 * nothing clears it when that Member is removed from the company (only full
 * account deletion does), so the column can name someone who no longer
 * belongs here. That matters because callers use this answer as an audience:
 * push subscriptions are per-account and outlive a membership, so an
 * unchecked pointer would deliver company activity to an ex-colleague's
 * phone. A dangling pointer therefore reads as "no manager".
 */
export async function managingMemberIdForEmployee(
  companyId: string,
  employeeId: string,
): Promise<string | null> {
  const repo = AppDataSource.getRepository(AIEmployee);
  const seen = new Set<string>();
  let currentId: string | null = employeeId;
  for (let depth = 0; currentId && depth < MAX_REPORTING_DEPTH; depth += 1) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const employee: AIEmployee | null = await repo.findOne({
      where: { id: currentId, companyId },
      select: { id: true, reportsToEmployeeId: true, reportsToUserId: true },
    });
    if (!employee) return null;
    if (employee.reportsToUserId) {
      const stillAMember = await AppDataSource.getRepository(Membership).countBy({
        companyId,
        userId: employee.reportsToUserId,
      });
      return stillAMember > 0 ? employee.reportsToUserId : null;
    }
    currentId = employee.reportsToEmployeeId;
  }
  return null;
}

/** True when `userId` is the human at the top of `employeeId`'s reporting line. */
export async function memberManagesEmployee(
  companyId: string,
  employeeId: string,
  userId: string,
): Promise<boolean> {
  return (await managingMemberIdForEmployee(companyId, employeeId)) === userId;
}
