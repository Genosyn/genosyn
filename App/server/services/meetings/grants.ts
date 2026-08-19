import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import {
  CALENDAR_ACCESS_RANK,
  EmployeeCalendarGrant,
  type CalendarAccessLevel,
} from "../../db/entities/EmployeeCalendarGrant.js";

/**
 * Which AI Employees may see which calendars.
 *
 * Members bypass this entirely — a human with company access sees the whole
 * section. This table governs only the AI surface, exactly as
 * `EmployeeMailAccountGrant` does for mailboxes, and it is re-checked at call
 * time rather than trusted from whenever somebody ticked a box: a grant
 * revoked yesterday has to take effect today.
 */

export async function getCalendarGrant(
  employeeId: string,
  accountId: string,
): Promise<EmployeeCalendarGrant | null> {
  return AppDataSource.getRepository(EmployeeCalendarGrant).findOneBy({ employeeId, accountId });
}

/** Does this employee hold at least `required` on this calendar? */
export async function hasCalendarAccess(
  employeeId: string,
  accountId: string,
  required: CalendarAccessLevel,
): Promise<boolean> {
  const grant = await getCalendarGrant(employeeId, accountId);
  if (!grant) return false;
  return CALENDAR_ACCESS_RANK[grant.accessLevel] >= CALENDAR_ACCESS_RANK[required];
}

/** Calendar ids this employee may read. Empty means "none", not "all". */
export async function grantedCalendarIds(employeeId: string): Promise<string[]> {
  const grants = await AppDataSource.getRepository(EmployeeCalendarGrant).find({
    where: { employeeId },
    select: { accountId: true },
  });
  return grants.map((row) => row.accountId);
}

export async function upsertCalendarGrant(args: {
  companyId: string;
  employeeId: string;
  accountId: string;
  accessLevel: CalendarAccessLevel;
}): Promise<EmployeeCalendarGrant> {
  // Both sides are re-checked against the company so a grant can never be
  // written across a tenant boundary by id-guessing.
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: args.employeeId,
    companyId: args.companyId,
  });
  if (!employee) throw new Error("AI Employee not found.");
  const account = await AppDataSource.getRepository(CalendarAccount).findOneBy({
    id: args.accountId,
    companyId: args.companyId,
  });
  if (!account) throw new Error("Calendar not found.");

  const repo = AppDataSource.getRepository(EmployeeCalendarGrant);
  const existing = await repo.findOneBy({ employeeId: args.employeeId, accountId: args.accountId });
  if (existing) {
    existing.accessLevel = args.accessLevel;
    return repo.save(existing);
  }
  return repo.save(
    repo.create({
      employeeId: args.employeeId,
      accountId: args.accountId,
      accessLevel: args.accessLevel,
    }),
  );
}

export async function deleteCalendarGrant(args: {
  companyId: string;
  employeeId: string;
  accountId: string;
}): Promise<boolean> {
  const account = await AppDataSource.getRepository(CalendarAccount).findOneBy({
    id: args.accountId,
    companyId: args.companyId,
  });
  if (!account) return false;
  const result = await AppDataSource.getRepository(EmployeeCalendarGrant).delete({
    employeeId: args.employeeId,
    accountId: args.accountId,
  });
  return (result.affected ?? 0) > 0;
}

export type HydratedCalendarGrant = {
  employeeId: string;
  employeeName: string;
  employeeSlug: string;
  accountId: string;
  accountLabel: string;
  accessLevel: CalendarAccessLevel;
};

/** Every grant in the company, hydrated for the AI-access page. */
export async function listCalendarGrants(companyId: string): Promise<HydratedCalendarGrant[]> {
  const accounts = await AppDataSource.getRepository(CalendarAccount).find({ where: { companyId } });
  if (accounts.length === 0) return [];
  const byId = new Map(accounts.map((row) => [row.id, row]));

  const grants = await AppDataSource.getRepository(EmployeeCalendarGrant).find();
  const relevant = grants.filter((grant) => byId.has(grant.accountId));
  if (relevant.length === 0) return [];

  const employees = await AppDataSource.getRepository(AIEmployee).find({ where: { companyId } });
  const employeeById = new Map(employees.map((row) => [row.id, row]));

  const out: HydratedCalendarGrant[] = [];
  for (const grant of relevant) {
    const employee = employeeById.get(grant.employeeId);
    const account = byId.get(grant.accountId);
    if (!employee || !account) continue;
    out.push({
      employeeId: employee.id,
      employeeName: employee.name,
      employeeSlug: employee.slug,
      accountId: account.id,
      accountLabel: account.displayName || account.address || account.calendarId,
      accessLevel: grant.accessLevel,
    });
  }
  return out;
}
