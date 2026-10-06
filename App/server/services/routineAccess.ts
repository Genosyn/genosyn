import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  DEFAULT_ROUTINE_ACCESS,
  EmployeeRoutineGrant,
  ROUTINE_ACCESS_LEVELS,
  ROUTINE_ACCESS_RANK,
  type RoutineAccessLevel,
} from "../db/entities/EmployeeRoutineGrant.js";

/**
 * Routines → AI access: which AI Employees may change Routines.
 *
 * Every employee reads, runs, and writes Routines by default; an owner or admin
 * can narrow one to read + run. A read + run employee still reads every Routine
 * and its Runs, and its Routines keep running, but it cannot create, edit,
 * re-schedule, pause, re-file, or delete any Routine — and no AI Employee can
 * change *its* Routines either.
 *
 * Enforcement lives at the MCP seam (`routes/mcpInternal.ts`), which asks
 * {@link routineWriteRefusalForActor} and {@link routineWriteRefusalForOwner}
 * before every tool in {@link ROUTINE_WRITE_TOOLS} — ahead of the taint gate,
 * so a write the employee could never make is refused rather than held for a
 * human approval that could not let it through. The same answer feeds
 * `grantDead.ts`, so the write tools leave a restricted employee's working set
 * and `find_tools` marks them dead; the tools briefing in
 * `agent/systemPrompt.ts`, so its prompt says so before it tries; and Pipeline
 * authoring (`pipelines/authoring.ts`), where a schedule trigger is recurring
 * work by another name.
 */

/**
 * Every MCP tool that writes a Routine. A read + run employee is refused each
 * one, for every Routine. Folders and Tags are written only through the
 * `folder` and `tags` arguments of the first two, so they fall with them.
 */
export const ROUTINE_WRITE_TOOLS = ["create_routine", "update_routine", "delete_routine"] as const;

/**
 * The Routine and Run tools that only read. They never consult this setting:
 * reading Routines and Runs is what both levels share.
 */
export const ROUTINE_READ_TOOLS = [
  "list_routines",
  "get_routine",
  "list_runs",
  "get_run_report",
  "get_participating_routine",
] as const;

/**
 * The 403 a read + run employee gets from a Routine write. It names the
 * setting and where it lives, says what still works, and points at the one
 * way to suggest a change that stays open — a Revision proposal, which a human
 * applies — so the model reports the limit instead of retrying.
 */
export const ROUTINE_RUN_ONLY_ERROR =
  'No grant: this needs "write" access to Routines; yours is "run" (read + run), so you cannot create, edit, re-schedule, pause, re-file, or delete any Routine — yours or a teammate\'s. You can still read Routines and their Runs, and your Routines keep running. Ask an owner or admin to change it under Routines → AI access, or ask a Member to make this change. To suggest a better brief for a Routine you own, use propose_revision; a human applies it.';

/**
 * The 403 a read + write employee gets for a Routine owned by a read + run
 * teammate. The teammate's Routines change only through a Member, so a
 * restricted employee cannot route a change through someone who may write.
 */
export function routineOwnerRunOnlyError(ownerName: string): string {
  return `No grant: ${ownerName}'s access to Routines is "run" (read + run, under Routines → AI access), so no AI Employee can create, edit, re-schedule, pause, re-file, or delete ${ownerName}'s Routines. Ask an owner or admin to make this change, or to change ${ownerName}'s access under Routines → AI access.`;
}

/**
 * What a read + run employee is told when it tries to put a Pipeline on a
 * schedule. A schedule trigger is recurring work, which is exactly what the
 * level takes away; `pipelines/authoring.ts` lets an employee author only
 * what it could do itself.
 */
export const ROUTINE_SCHEDULE_TRIGGER_REFUSAL =
  'A schedule makes this Pipeline recurring work, and your access to Routines is "run" (read + run, under Routines → AI access), which does not include scheduling recurring work. Use a manual or webhook trigger, or ask an owner or admin to add the schedule in the Pipelines builder.';

export class RoutineAccessNotFoundError extends Error {}

/**
 * The level a stored value grants.
 *
 * No row means the default (`write`). A value this build does not recognize
 * fails closed to `run`: a newer level left behind by a rollback must never
 * widen what an employee can do. Compared by membership rather than by indexing
 * the rank map, so a value like `"toString"` cannot resolve to something truthy.
 */
export function effectiveRoutineAccess(stored: string | null | undefined): RoutineAccessLevel {
  if (stored === null || stored === undefined) return DEFAULT_ROUTINE_ACCESS;
  return (ROUTINE_ACCESS_LEVELS as string[]).includes(stored)
    ? (stored as RoutineAccessLevel)
    : "run";
}

/** True when this level lets an employee create, edit, or delete Routines at all. */
export function canWriteRoutines(level: RoutineAccessLevel): boolean {
  return ROUTINE_ACCESS_RANK[level] >= ROUTINE_ACCESS_RANK.write;
}

/** One employee's effective level. Keyed by employee alone — the row is unique on it. */
export async function getRoutineAccess(employeeId: string): Promise<RoutineAccessLevel> {
  const row = await AppDataSource.getRepository(EmployeeRoutineGrant).findOneBy({ employeeId });
  return effectiveRoutineAccess(row?.accessLevel);
}

/**
 * Why the employee making a tool call may not write Routines, or null when it
 * may. Checked before anything is looked up: a read + run employee is refused
 * every Routine write, whichever Routine it names.
 */
export async function routineWriteRefusalForActor(employeeId: string): Promise<string | null> {
  return canWriteRoutines(await getRoutineAccess(employeeId)) ? null : ROUTINE_RUN_ONLY_ERROR;
}

/**
 * Why no AI Employee may write this employee's Routines, or null when one with
 * read + write access may. The owner of a Routine — or the employee a new one
 * would belong to — must hold read + write too, otherwise a read + run
 * employee could hand its change to a teammate and have it made anyway.
 */
export async function routineWriteRefusalForOwner(owner: {
  id: string;
  name: string;
}): Promise<string | null> {
  return canWriteRoutines(await getRoutineAccess(owner.id))
    ? null
    : routineOwnerRunOnlyError(owner.name);
}

export type RoutineAccessChange = {
  employee: AIEmployee;
  /** The effective level before the call. */
  previous: RoutineAccessLevel;
  accessLevel: RoutineAccessLevel;
  /** False when nothing was written — the caller audits only real changes. */
  changed: boolean;
};

/**
 * Set one employee's level.
 *
 * Idempotent. Asking for the level an employee already holds writes nothing,
 * and that includes asking for `write` on an employee with no row: absence
 * already means `write`, so a second representation of the default would only
 * be noise. Any other request upserts the row, which also replaces a stored
 * value this build does not recognize.
 *
 * Throws {@link RoutineAccessNotFoundError} when the employee is not in this
 * company — an employee of another company is answered exactly like an id that
 * does not exist.
 */
export async function setRoutineAccess(
  companyId: string,
  employeeId: string,
  accessLevel: RoutineAccessLevel,
): Promise<RoutineAccessChange> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new RoutineAccessNotFoundError("AI Employee not found");

  const repo = AppDataSource.getRepository(EmployeeRoutineGrant);
  const row = await repo.findOneBy({ employeeId: employee.id });
  const previous = effectiveRoutineAccess(row?.accessLevel);
  const stored = row ? row.accessLevel : DEFAULT_ROUTINE_ACCESS;
  if (stored === accessLevel) return { employee, previous, accessLevel, changed: false };

  if (row) {
    row.accessLevel = accessLevel;
    // Keep the denormalized companyId honest, as the Finance grant does.
    row.companyId = companyId;
    await repo.save(row);
  } else {
    await repo.save(repo.create({ companyId, employeeId: employee.id, accessLevel }));
  }
  return { employee, previous, accessLevel, changed: true };
}

export type RoutineAccessRow = {
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  };
  accessLevel: RoutineAccessLevel;
  /** True when nobody has set this employee's access, so the default applies. */
  isDefault: boolean;
};

function toRow(employee: AIEmployee, stored: string | undefined): RoutineAccessRow {
  return {
    employee: {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
      avatarKey: employee.avatarKey ?? null,
    },
    accessLevel: effectiveRoutineAccess(stored),
    isDefault: stored === undefined,
  };
}

/**
 * Every AI Employee in the company, alphabetical, with its effective level. An
 * employee nobody has touched is listed at the default — the page shows the
 * whole roster, not only the exceptions.
 *
 * The stored rows are matched through a subquery over the company's employees
 * rather than by the row's own `companyId`, so the list can never disagree with
 * the MCP gate, which keys by employee alone. A subquery rather than an
 * expanded `IN (:...ids)` keeps a large roster clear of SQLite's bound-parameter
 * ceiling, and the `CAST` is for Postgres, where `ai_employees.id` is a uuid
 * and `employeeId` a varchar. Both queries read at most one row per employee.
 */
export async function listRoutineAccess(companyId: string): Promise<RoutineAccessRow[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    order: { name: "ASC" },
  });
  if (employees.length === 0) return [];
  const stored = await AppDataSource.getRepository(EmployeeRoutineGrant)
    .createQueryBuilder("g")
    .where((qb) => {
      const ids = qb
        .subQuery()
        .select("CAST(e.id AS text)")
        .from(AIEmployee, "e")
        .where("e.companyId = :companyId")
        .getQuery();
      return `g.employeeId IN ${ids}`;
    })
    .setParameter("companyId", companyId)
    .getMany();
  const levelByEmployee = new Map(stored.map((row) => [row.employeeId, row.accessLevel]));
  return employees.map((employee) => toRow(employee, levelByEmployee.get(employee.id)));
}

/** One employee's row, in the shape the list returns; null when it is not in this company. */
export async function getRoutineAccessRow(
  companyId: string,
  employeeId: string,
): Promise<RoutineAccessRow | null> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) return null;
  const stored = await AppDataSource.getRepository(EmployeeRoutineGrant).findOneBy({
    employeeId: employee.id,
  });
  return toRow(employee, stored?.accessLevel);
}

/** Drop a fired employee's row, so it never lingers matching nobody. */
export async function deleteRoutineAccessForEmployee(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeRoutineGrant).delete({ employeeId });
}
