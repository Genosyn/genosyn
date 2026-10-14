import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { isValidTimeZone } from "../lib/timeZone.js";
import { nextRunFor } from "./cronMath.js";

/**
 * Which clock a company's Routines are scheduled on.
 *
 * A Routine belongs to an AI Employee and the employee to a Company, and the
 * Company carries the zone (`Company.timezone`). The scheduler only ever holds
 * a Routine row, so it reaches the zone through the employee. Every answer here
 * is either a zone the runtime can schedule in or the empty string, which means
 * *server time* — the process's own clock, which is how every Routine ran
 * before a company could name one. Callers hand the answer straight to
 * `nextRunFor()` and `countMissedSlots()` and never need to ask whether it is
 * usable.
 *
 * Both lookups are primary-key reads on tables with one row per company or
 * employee, so they are safe to make from the heartbeat (§7: nothing here scans
 * a large table). A company that does not exist — a test fixture's opaque id,
 * or a row deleted under a Routine mid-pass — is server time, not an error: the
 * Routine keeps its old schedule rather than the pass failing.
 */

const warned = new Set<string>();

/**
 * What a stored `Company.timezone` means to the scheduler. The API refuses
 * unknown names, but the stored text outlives the runtime that validated it: a
 * name added to a newer Node's tables and then read by an older one, or a row
 * written by hand. Falling back to server time keeps such a company's Routines
 * firing; saying so once per name keeps that from being silent.
 */
export function schedulingZone(stored: string | null | undefined, companyId?: string): string {
  const zone = (stored ?? "").trim();
  if (!zone) return "";
  if (isValidTimeZone(zone)) return zone;
  const key = `${companyId ?? ""}:${zone}`;
  if (!warned.has(key)) {
    if (warned.size >= 256) warned.clear();
    warned.add(key);
    // eslint-disable-next-line no-console
    console.warn(
      `[cron] time zone "${zone}"${companyId ? ` of company ${companyId}` : ""} is not known to this runtime — scheduling its Routines in server time`,
    );
  }
  return "";
}

/** The zone this company's Routines are scheduled in, or "" for server time. */
export async function companyTimeZone(companyId: string): Promise<string> {
  const company = await AppDataSource.getRepository(Company).findOne({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  return schedulingZone(company?.timezone, companyId);
}

/** The zone of the company this employee works in, or "" for server time. */
export async function employeeTimeZone(employeeId: string): Promise<string> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOne({
    where: { id: employeeId },
    select: { id: true, companyId: true },
  });
  return employee ? companyTimeZone(employee.companyId) : "";
}

/**
 * A memoizing {@link employeeTimeZone} for one scheduling pass.
 *
 * The heartbeat, the boot sweep and the post-restore reset each walk many
 * Routines that share a handful of employees and companies; asking once per
 * employee keeps a pass at a few reads however long the list is. Create one per
 * pass and let it go — it never expires, so a long-lived one would keep
 * answering with a zone somebody has since changed.
 */
export function timeZoneLookup(): (employeeId: string) => Promise<string> {
  const byEmployee = new Map<string, Promise<string>>();
  const byCompany = new Map<string, Promise<string>>();
  return (employeeId) => {
    let pending = byEmployee.get(employeeId);
    if (!pending) {
      pending = (async () => {
        const employee = await AppDataSource.getRepository(AIEmployee).findOne({
          where: { id: employeeId },
          select: { id: true, companyId: true },
        });
        if (!employee) return "";
        let company = byCompany.get(employee.companyId);
        if (!company) {
          company = companyTimeZone(employee.companyId);
          byCompany.set(employee.companyId, company);
        }
        return company;
      })();
      byEmployee.set(employeeId, pending);
    }
    return pending;
  };
}

/**
 * Re-anchor a company's enabled Routines after its time zone changed.
 *
 * Each Routine's `nextRunAt` was computed on the old clock, so left alone
 * "every morning at 8" would still fire once at the old 8 before the new zone
 * took over — and, moving west, as much as a day later than the new 8.
 * Recomputing from now puts the very next fire where the person who changed
 * the zone expects it. That is the same as editing every schedule at once: a
 * slot already past is not served late, it is simply passed over.
 *
 * Each row is written with a guarded UPDATE rather than `save()`, so a
 * concurrent edit to the schedule (which computes its own `nextRunAt` on the
 * new clock) or a heartbeat advance is never overwritten by this stale read.
 * When the guard loses, the row is read again and judged on what is there now,
 * a few times at most. Returns how many Routines moved.
 */
export async function rescheduleCompanyRoutines(
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const timeZone = await companyTimeZone(companyId);
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: { id: true },
  });
  if (employees.length === 0) return 0;
  const repo = AppDataSource.getRepository(Routine);
  const routines = await repo.find({
    where: { employeeId: In(employees.map((employee) => employee.id)), enabled: true },
  });
  let moved = 0;
  for (const routine of routines) {
    let current: Routine | null = routine;
    for (let attempt = 0; attempt < 3 && current?.enabled; attempt += 1) {
      const next = nextRunFor(current.cronExpr, now, timeZone);
      if (next === null || current.nextRunAt?.getTime() === next.getTime()) break;
      const updated = await repo.update(
        {
          id: current.id,
          enabled: true,
          cronExpr: current.cronExpr,
          nextRunAt: current.nextRunAt ?? IsNull(),
        },
        { nextRunAt: next },
      );
      if (updated.affected === 1) {
        moved += 1;
        break;
      }
      current = await repo.findOneBy({ id: routine.id });
    }
  }
  return moved;
}
