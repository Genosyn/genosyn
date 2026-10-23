import { In, IsNull, MoreThan, Not, type Repository } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import {
  DEFAULT_ROUTINE_PRIORITY,
  isRoutinePriority,
  orderQueuedRuns,
  type QueuedRunOrderFields,
  type RoutinePriority,
} from "../../shared/routinePriority.js";
import { workBlocked } from "./standdowns.js";

/**
 * The order the Routine queue starts waiting Runs in, read from the database.
 *
 * The rule itself is `shared/routinePriority.ts`. This module reads what the
 * rule needs, and nothing past it:
 *
 *   - **Waiting Runs, through an index.** `runs` is the largest table in the
 *     App and its transcripts sit in the middle of every row, so the waiting
 *     set is always reached through an index that bounds it — `status` for the
 *     whole install, `(employeeId, status)` for one company — and never by
 *     walking a Routine's or a company's Run history to filter it. Nothing here
 *     sorts in SQL: the waiting set is small and the order is decided in memory.
 *   - **Priority from the Routine, now.** No Run carries a copy, so a priority
 *     changed while Runs wait moves them at the next pass, and a Run created a
 *     moment after the change can never keep the old one.
 */

/** A Run waiting to start, with what the queue orders it by. */
export type QueuedRun = QueuedRunOrderFields & {
  routineId: string;
  employeeId: string | null;
  createdAt: Date;
};

const KEY_FIELDS = {
  id: true,
  routineId: true,
  employeeId: true,
  createdAt: true,
  pauseCount: true,
  continuationCount: true,
} as const;

/** Keep each `IN (…)` list well under every driver's parameter limit. */
const IN_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

type RoutineOwner = { employeeId: string; priority: RoutinePriority };

/** Each Routine's owner and priority, as stored right now. A Routine that is gone is absent. */
async function routineOwners(routineIds: Iterable<string>): Promise<Map<string, RoutineOwner>> {
  const ids = [...new Set(routineIds)];
  const owners = new Map<string, RoutineOwner>();
  for (const part of chunks(ids)) {
    const rows = await AppDataSource.getRepository(Routine).find({
      where: { id: In(part) },
      select: { id: true, employeeId: true, priority: true },
    });
    for (const row of rows) {
      owners.set(row.id, {
        employeeId: row.employeeId,
        priority: isRoutinePriority(row.priority) ? row.priority : DEFAULT_ROUTINE_PRIORITY,
      });
    }
  }
  return owners;
}

function queuedRun(row: Run, owner: RoutineOwner | undefined): QueuedRun {
  return {
    id: row.id,
    routineId: row.routineId,
    employeeId: row.employeeId,
    createdAt: row.createdAt,
    pauseCount: row.pauseCount ?? 0,
    continuationCount: row.continuationCount ?? 0,
    priority: owner?.priority ?? DEFAULT_ROUTINE_PRIORITY,
  };
}

/**
 * Every Run waiting to start across the install, in the order the dispatcher
 * offers them to their AI Models. Bounded by the `status` index to waiting Runs.
 */
export async function queuedRunsInStartOrder(): Promise<QueuedRun[]> {
  const rows = await AppDataSource.getRepository(Run).find({
    where: { status: "queued", employeeId: Not(IsNull()) },
    select: KEY_FIELDS,
  });
  const owners = await routineOwners(rows.map((row) => row.routineId));
  return orderQueuedRuns(rows.map((row) => queuedRun(row, owners.get(row.routineId))));
}

/**
 * Every Run holding a dispatch claim right now: the Runs working, and the ones
 * still assessing after they finished. Read through the claim's own unique
 * index, which holds a handful of entries. `IS NOT NULL` would read past every
 * transcript in `runs` to find them (AGENTS.md §7), and filtering a Routine's
 * Runs by claim would walk its whole history; claims are never empty, so
 * `> ''` is the same test as a range the index answers.
 */
export async function claimedRuns(
  repo: Repository<Run> = AppDataSource.getRepository(Run),
): Promise<Pick<Run, "id" | "routineId">[]> {
  return repo.find({
    where: { queueActiveEmployeeId: MoreThan("") },
    select: { id: true, routineId: true },
  });
}

/** A company's waiting Run, with its place in line. */
export type CompanyQueuedRun = QueuedRun & {
  /** The Routine's current owner, or null when the Routine is gone. */
  routineEmployeeId: string | null;
  /**
   * Its place among the company's Runs the queue will offer, 1 being next up.
   * Null for a Run the queue passes over until something changes: one covered
   * by a Standdown, one still holding an earlier claim, or one its reassigned
   * Routine left behind (the dispatcher ends it rather than starting it).
   */
  position: number | null;
};

/**
 * One company's waiting Runs, in start order, each with its place in line.
 *
 * Reached through `(employeeId, status)` for each of the company's AI
 * Employees, so a company with years of Run history reads only what waits.
 * The order is the dispatcher's: a company's Runs keep their relative order
 * however many other companies share an AI Model with them.
 */
export async function companyRunQueue(companyId: string): Promise<CompanyQueuedRun[]> {
  const employeeIds = (
    await AppDataSource.getRepository(AIEmployee).find({
      where: { companyId },
      select: { id: true },
    })
  ).map((employee) => employee.id);
  if (employeeIds.length === 0) return [];
  const runs = AppDataSource.getRepository(Run);
  const rows: Run[] = [];
  for (const part of chunks(employeeIds)) {
    rows.push(
      ...(await runs.find({
        where: { status: "queued", employeeId: In(part) },
        select: KEY_FIELDS,
      })),
    );
  }
  // Runs queued before Runs recorded their employee wait unnamed; the queue
  // never offers them, but they are still this company's when their Routine is.
  rows.push(
    ...(await runs.find({ where: { status: "queued", employeeId: IsNull() }, select: KEY_FIELDS })),
  );
  if (rows.length === 0) return [];
  const owners = await routineOwners(rows.map((row) => row.routineId));
  const company = new Set(employeeIds);
  const theirs = rows.filter((row) => {
    const owner = owners.get(row.routineId);
    return row.employeeId ? company.has(row.employeeId) : !!owner && company.has(owner.employeeId);
  });
  if (theirs.length === 0) return [];
  // A queued Run still holding a claim cannot be claimed again until that
  // claim is released; only a stranded legacy claim leaves one.
  const claimed = new Set((await claimedRuns(runs)).map((run) => run.id));
  let position = 0;
  return orderQueuedRuns(theirs.map((row) => queuedRun(row, owners.get(row.routineId)))).map(
    (run) => {
      const owner = owners.get(run.routineId);
      const inLine =
        !!owner &&
        owner.employeeId === run.employeeId &&
        !claimed.has(run.id) &&
        !workBlocked(companyId, { employeeId: owner.employeeId, routineId: run.routineId }).blocked;
      return {
        ...run,
        routineEmployeeId: owner?.employeeId ?? null,
        position: inLine ? ++position : null,
      };
    },
  );
}
