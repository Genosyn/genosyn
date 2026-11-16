import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream, type WorkstreamStatus } from "../db/entities/Workstream.js";
// The shared uuid-PK guard — see routineFolders.ts for the Postgres 22P02 story.
import { UUID_RE } from "./bases.js";
import { recordAudit } from "./audit.js";
import { Not, type EntityManager, type SelectQueryBuilder } from "typeorm";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { WORKSTREAM_REVISIT_MAX_AHEAD_MS } from "../../shared/routineRunCondition.js";

/**
 * Workstreams — the employee as its own project state-holder (M54). The
 * invariants live here so the MCP handlers and the human read routes agree:
 * only the owning employee writes, one Routine binds at most one active
 * workstream (the brief seam must be unambiguous), and terminal states
 * always say why.
 */

const STATE_DOC_MAX = 40_000;
const ACTIVE_PER_EMPLOYEE_MAX = 20;

export class WorkstreamError extends Error {}

/**
 * Check a revisit time an employee asked for. Undefined leaves the current one
 * as it is and null clears it. Any past time means "as soon as possible"; a
 * time beyond {@link WORKSTREAM_REVISIT_MAX_AHEAD_MS} is a mistake, not a plan.
 */
export function parseWorkstreamRevisit(
  value: string | null | undefined,
  now: Date = new Date(),
): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const at = new Date(value);
  if (!value.trim() || !Number.isFinite(at.getTime())) {
    throw new WorkstreamError(
      "revisitAt must be an ISO 8601 date and time, such as 2026-05-04T09:00:00Z, or null to clear it.",
    );
  }
  if (at.getTime() > now.getTime() + WORKSTREAM_REVISIT_MAX_AHEAD_MS) {
    throw new WorkstreamError(
      "revisitAt is more than two years away. Plan the next time this work needs a look, not when it ends.",
    );
  }
  return at;
}

const writeQueues = new Map<string, Promise<unknown>>();
async function withWorkstreamWrite<T>(
  companyId: string,
  employeeId: string,
  write: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const key =
    AppDataSource.options.type === "better-sqlite3" ? "sqlite" : `${companyId}:${employeeId}`;
  const prior = writeQueues.get(key) ?? Promise.resolve();
  const pending = prior
    .catch(() => undefined)
    .then(() =>
      AppDataSource.transaction(async (manager) => {
        // Serialize one employee across Postgres replicas as well as this process.
        const employee = await manager.getRepository(AIEmployee).findOne({
          where: { id: employeeId, companyId },
          ...(AppDataSource.options.type === "postgres"
            ? { lock: { mode: "pessimistic_write" as const } }
            : {}),
        });
        if (!employee) throw new WorkstreamError("AI Employee not found");
        return write(manager);
      }),
    );
  writeQueues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (writeQueues.get(key) === pending) writeQueues.delete(key);
  }
}

async function assertActiveCapacity(manager: EntityManager, companyId: string, employeeId: string) {
  const active = await manager
    .getRepository(Workstream)
    .countBy({ companyId, employeeId, status: "active" });
  if (active >= ACTIVE_PER_EMPLOYEE_MAX)
    throw new WorkstreamError(
      `You already carry ${active} active Workstreams. Archive one with update_workstream (status: archived, closeReason: why it can wait), or finish it, before creating or resuming another. Archived state remains readable and can be resumed explicitly.`,
    );
}

export async function createWorkstream(args: {
  companyId: string;
  employeeId: string;
  title: string;
  objective?: string;
  stateDoc?: string;
  routineId?: string | null;
  /** When the employee next needs to look at it; null or omitted plans nothing. */
  revisitAt?: Date | null;
  /** Internal: business Runs cannot bind suggestion-only review Routines. */
  excludeSelfReviews?: boolean;
}): Promise<Workstream> {
  return withWorkstreamWrite(args.companyId, args.employeeId, async (manager) => {
    const title = args.title.trim();
    if (!title) throw new WorkstreamError("A workstream needs a title");
    const repo = manager.getRepository(Workstream);
    await assertActiveCapacity(manager, args.companyId, args.employeeId);
    if (args.routineId) {
      await assertBindableRoutine(
        args.employeeId,
        args.routineId,
        args.excludeSelfReviews,
        manager,
      );
    }
    return repo.save(
      repo.create({
        companyId: args.companyId,
        employeeId: args.employeeId,
        title: title.slice(0, 140),
        objective: (args.objective ?? "").trim().slice(0, 4_000),
        stateDoc: (args.stateDoc ?? "").slice(0, STATE_DOC_MAX),
        routineId: args.routineId ?? null,
        revisitAt: args.revisitAt ?? null,
      }),
    );
  });
}

async function assertBindableRoutine(
  employeeId: string,
  routineId: string,
  excludeSelfReviews = false,
  manager = AppDataSource.manager,
  ignoreWorkstreamId?: string,
): Promise<void> {
  if (!UUID_RE.test(routineId)) throw new WorkstreamError("That routine is not yours to bind");
  const routine = await manager.getRepository(Routine).findOneBy({
    id: routineId,
    employeeId,
  });
  if (!routine) throw new WorkstreamError("That routine is not yours to bind");
  if (excludeSelfReviews && routine.selfReviewOnly) {
    throw new WorkstreamError("A self-review Routine cannot carry background business work");
  }
  const bound = await manager.getRepository(Workstream).countBy({
    routineId,
    status: "active",
    ...(ignoreWorkstreamId ? { id: Not(ignoreWorkstreamId) } : {}),
  });
  if (bound > 0) {
    throw new WorkstreamError(
      "That routine already carries an active workstream — its brief seam must stay unambiguous",
    );
  }
}

export async function updateWorkstream(args: {
  companyId: string;
  employeeId: string;
  workstreamId: string;
  stateDoc?: string;
  status?: WorkstreamStatus;
  closeReason?: string;
  routineId?: string | null;
  lastRunId?: string | null;
  /** Undefined keeps the planned revisit; null clears it. */
  revisitAt?: Date | null;
}): Promise<Workstream> {
  return withWorkstreamWrite(args.companyId, args.employeeId, async (manager) => {
    if (!UUID_RE.test(args.workstreamId)) throw new WorkstreamError("Workstream not found");
    const repo = manager.getRepository(Workstream);
    const workstream = await repo.findOneBy({
      id: args.workstreamId,
      companyId: args.companyId,
      employeeId: args.employeeId,
    });
    if (!workstream) throw new WorkstreamError("Workstream not found — only your own can change");
    if (workstream.status !== "active" && args.status === undefined) {
      throw new WorkstreamError(
        `This workstream is ${workstream.status}; reopen it explicitly first`,
      );
    }
    if (args.status === "active" && workstream.status !== "active") {
      await assertActiveCapacity(manager, args.companyId, args.employeeId);
      const binding = args.routineId === undefined ? workstream.routineId : args.routineId;
      if (binding)
        await assertBindableRoutine(args.employeeId, binding, false, manager, workstream.id);
    }
    if (args.stateDoc !== undefined) {
      workstream.stateDoc = args.stateDoc.slice(0, STATE_DOC_MAX);
    }
    if (args.routineId !== undefined) {
      if (args.routineId)
        await assertBindableRoutine(args.employeeId, args.routineId, false, manager, workstream.id);
      workstream.routineId = args.routineId;
    }
    if (args.status !== undefined && args.status !== workstream.status) {
      if (
        (args.status === "abandoned" || args.status === "archived") &&
        !(args.closeReason ?? "").trim()
      ) {
        throw new WorkstreamError(
          args.status === "archived"
            ? "Archiving needs a reason; preserve the state needed to resume."
            : "Abandoning needs a reason — work never just evaporates",
        );
      }
      workstream.status = args.status;
      workstream.closeReason =
        args.status === "active" ? "" : (args.closeReason ?? "").trim().slice(0, 2_000);
    }
    if (args.revisitAt !== undefined) workstream.revisitAt = args.revisitAt;
    // Work that stopped is waiting on nothing: a revisit planned before it was
    // archived or closed must not wake anything, nor come back on resuming.
    if (workstream.status !== "active") workstream.revisitAt = null;
    if (args.lastRunId !== undefined) workstream.lastRunId = args.lastRunId;
    return repo.save(workstream);
  });
}

type WorkstreamReadFilter = {
  employeeId?: string;
  status?: WorkstreamStatus;
  /** Internal: business Runs must not consume suggestion-only review tracking. */
  excludeSelfReviews?: boolean;
};

function workstreamReadQuery(companyId: string, filter: WorkstreamReadFilter) {
  const query = AppDataSource.getRepository(Workstream)
    .createQueryBuilder("workstream")
    .where("workstream.companyId = :companyId", { companyId });
  if (filter.employeeId) {
    query.andWhere("workstream.employeeId = :employeeId", { employeeId: filter.employeeId });
  }
  if (filter.status) query.andWhere("workstream.status = :status", { status: filter.status });
  if (filter.excludeSelfReviews) excludeSelfReviewTracking(query);
  return query.orderBy("workstream.updatedAt", "DESC").addOrderBy("workstream.id", "DESC");
}

/**
 * Keep suggestion-only review tracking out of a read of business work. Filters
 * before any limit. Orphaned bindings stay withheld too: deleting a review
 * Routine must not turn its historical tracking into business work.
 */
function excludeSelfReviewTracking(query: SelectQueryBuilder<Workstream>): void {
  query.andWhere((sub) => {
    const businessRoutine = sub
      .subQuery()
      .select("1")
      .from(Routine, "boundRoutine")
      .where("CAST(boundRoutine.id AS text) = workstream.routineId")
      .andWhere("boundRoutine.employeeId = workstream.employeeId")
      .andWhere("boundRoutine.selfReviewOnly = :selfReviewOnly", { selfReviewOnly: false })
      .getQuery();
    return `(workstream.routineId IS NULL OR EXISTS ${businessRoutine})`;
  });
}

/** What a run condition needs to know about one Workstream. */
export type WorkstreamRevisit = Pick<Workstream, "id" | "title" | "revisitAt" | "routineId">;

/** The Routine a run condition is decided for. */
type RevisitingRoutine = { id: string; employeeId: string; selfReviewOnly: boolean };

/**
 * The Workstreams a Routine resumes: the employee's own, active, and either
 * unbound or bound to this Routine. One bound to another Routine is that
 * Routine's to carry on through its brief seam — and proactive preparation could
 * not touch it anyway — so its revisit wakes nobody else. A suggestion-only
 * review resumes only its own tracking, and business work never sees that
 * tracking, since it is always bound to its review. An orphaned binding stays
 * withheld, as in every business read.
 */
function revisitScope(routine: RevisitingRoutine) {
  const query = AppDataSource.getRepository(Workstream)
    .createQueryBuilder("workstream")
    .where("workstream.employeeId = :employeeId", { employeeId: routine.employeeId })
    .andWhere("workstream.status = :status", { status: "active" });
  if (routine.selfReviewOnly) {
    query.andWhere("workstream.routineId = :routineId", { routineId: routine.id });
  } else {
    query.andWhere("(workstream.routineId IS NULL OR workstream.routineId = :routineId)", {
      routineId: routine.id,
    });
  }
  return query;
}

/**
 * The Workstreams a Routine resumes that have a revisit planned, soonest first,
 * through the `(employeeId, status, revisitAt)` index.
 *
 * `dueBy` keeps only revisits that have come by then, and `after` only those
 * later than it — the time the Routine last looked, so a revisit it already
 * took up is not due again.
 */
export async function listWorkstreamRevisits(args: {
  routine: RevisitingRoutine;
  dueBy?: Date;
  after?: Date | null;
  limit: number;
}): Promise<WorkstreamRevisit[]> {
  const query = revisitScope(args.routine)
    .select(["workstream.id", "workstream.title", "workstream.revisitAt", "workstream.routineId"])
    .andWhere("workstream.revisitAt IS NOT NULL");
  if (args.dueBy) query.andWhere("workstream.revisitAt <= :dueBy", { dueBy: args.dueBy });
  if (args.after) query.andWhere("workstream.revisitAt > :after", { after: args.after });
  return query
    .orderBy("workstream.revisitAt", "ASC")
    .addOrderBy("workstream.id", "ASC")
    .take(args.limit)
    .getMany();
}

/** How many of the Workstreams a Routine resumes have no revisit planned. */
export async function countUnplannedWorkstreams(routine: RevisitingRoutine): Promise<number> {
  return revisitScope(routine).andWhere("workstream.revisitAt IS NULL").getCount();
}

export async function listWorkstreams(
  companyId: string,
  filter: WorkstreamReadFilter = {},
): Promise<Workstream[]> {
  return workstreamReadQuery(companyId, filter).take(200).getMany();
}

function textCoverage(value: string, offset: number, limit: number) {
  const returnedChars = value.slice(offset, offset + limit).length;
  const end = Math.min(value.length, offset + returnedChars);
  return {
    offset,
    returnedChars,
    totalChars: value.length,
    truncated: offset > 0 || end < value.length,
    nextOffset: end < value.length ? end : null,
  };
}

function workstreamSummary(workstream: Workstream) {
  return {
    textCoverage: {
      objective: textCoverage(workstream.objective, 0, 160),
      stateDoc: textCoverage(workstream.stateDoc, 0, 240),
      closeReason: textCoverage(workstream.closeReason, 0, 160),
    },
    ...serializeWorkstream(workstream),
    objective: workstream.objective.slice(0, 160),
    stateDoc: workstream.stateDoc.slice(0, 240),
    closeReason: workstream.closeReason.slice(0, 160),
  };
}

/** Compact, explicitly paged employee reads keep large state documents out of listings. */
export async function listEmployeeWorkstreams(args: {
  companyId: string;
  employeeId: string;
  all?: boolean;
  offset?: number;
  limit?: number;
  excludeSelfReviews?: boolean;
}) {
  const offset = boundedReadInteger(args.offset, 0, 0, 1_000_000);
  const limit = boundedReadInteger(args.limit, 5, 1, 20);
  const [rows, total] = await workstreamReadQuery(args.companyId, {
    employeeId: args.employeeId,
    ...(args.all ? {} : { status: "active" as const }),
    excludeSelfReviews: args.excludeSelfReviews,
  })
    .skip(offset)
    .take(limit)
    .getManyAndCount();
  const hasMore = offset + rows.length < total;
  const activeCount = await AppDataSource.getRepository(Workstream).countBy({
    companyId: args.companyId,
    employeeId: args.employeeId,
    status: "active",
  });
  return {
    capacity: {
      active: activeCount,
      limit: ACTIVE_PER_EMPLOYEE_MAX,
      available: Math.max(0, ACTIVE_PER_EMPLOYEE_MAX - activeCount),
    },
    coverage: {
      offset,
      limit,
      returned: rows.length,
      total,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
      scope: args.all ? "all statuses" : "active only",
      order: "updatedAt descending, id descending",
      snapshot: false,
    },
    workstreams: rows.map(workstreamSummary),
  };
}

export type WorkstreamTextField = "stateDoc" | "objective" | "closeReason";

/** An ID never bypasses the same company, employee and review scope as a listing. */
export async function readEmployeeWorkstream(args: {
  companyId: string;
  employeeId: string;
  workstreamId: string;
  field?: WorkstreamTextField;
  offset?: number;
  maxChars?: number;
  excludeSelfReviews?: boolean;
}) {
  if (!UUID_RE.test(args.workstreamId)) throw new WorkstreamError("Workstream not found");
  const row = await workstreamReadQuery(args.companyId, {
    employeeId: args.employeeId,
    excludeSelfReviews: args.excludeSelfReviews,
  })
    .andWhere("workstream.id = :id", { id: args.workstreamId })
    .getOne();
  if (!row) throw new WorkstreamError("Workstream not found");
  const field = args.field ?? "stateDoc";
  const offset = boundedReadInteger(args.offset, 0, 0, STATE_DOC_MAX);
  const maxChars = boundedReadInteger(args.maxChars, 4_000, 1, 8_000);
  return {
    field,
    coverage: textCoverage(row[field], offset, maxChars),
    workstream: workstreamSummary(row),
    text: row[field].slice(offset, offset + maxChars),
  };
}

function boundedReadInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WorkstreamError(`Read range must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Apply the same boundary when a background employee already knows a tracking ID. */
export async function assertBusinessWorkstream(
  companyId: string,
  employeeId: string,
  id: string,
): Promise<void> {
  if (!UUID_RE.test(id)) throw new WorkstreamError("Workstream not found");
  const workstream = await AppDataSource.getRepository(Workstream).findOneBy({
    id,
    companyId,
    employeeId,
  });
  if (!workstream) throw new WorkstreamError("Workstream not found — only your own can change");
  if (!workstream.routineId) return;
  const routine = UUID_RE.test(workstream.routineId)
    ? await AppDataSource.getRepository(Routine).findOneBy({
        id: workstream.routineId,
        employeeId,
        selfReviewOnly: false,
      })
    : null;
  if (!routine) {
    throw new WorkstreamError("This Workstream is not available to background business work");
  }
}

export async function getWorkstream(companyId: string, id: string): Promise<Workstream | null> {
  if (!UUID_RE.test(id)) return null;
  return AppDataSource.getRepository(Workstream).findOneBy({ id, companyId });
}

/** A human closing a stale stream — admin-gated at the route. */
export async function closeWorkstream(args: {
  companyId: string;
  workstreamId: string;
  status: "done" | "abandoned";
  reason: string;
  userId: string | null;
}): Promise<Workstream> {
  const workstream = await getWorkstream(args.companyId, args.workstreamId);
  if (!workstream) throw new WorkstreamError("Workstream not found");
  if (workstream.status !== "active") {
    throw new WorkstreamError(`This workstream is already ${workstream.status}`);
  }
  workstream.status = args.status;
  workstream.closeReason = args.reason.trim().slice(0, 2_000);
  // Closed work waits on nothing, so its planned revisit wakes no Routine.
  workstream.revisitAt = null;
  const saved = await AppDataSource.getRepository(Workstream).save(workstream);
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.userId,
    action: "workstream.close",
    targetType: "workstream",
    targetId: saved.id,
    targetLabel: saved.title,
    metadata: { status: args.status },
  });
  return saved;
}

export function serializeWorkstream(w: Workstream) {
  return {
    id: w.id,
    employeeId: w.employeeId,
    title: w.title,
    objective: w.objective,
    stateDoc: w.stateDoc,
    routineId: w.routineId,
    status: w.status,
    closeReason: w.closeReason,
    lastRunId: w.lastRunId,
    revisitAt: w.revisitAt ? w.revisitAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

/**
 * The brief seam: the bound Routine's Run opens with the latest state, so a
 * multi-week job resumes where it stood instead of re-reading a week of
 * journal. Empty string when the Routine carries no active workstream.
 */
export async function composeWorkstreamBlock(routineId: string): Promise<string> {
  const workstream = await AppDataSource.getRepository(Workstream).findOne({
    where: { routineId, status: "active" },
    order: { updatedAt: "DESC" },
  });
  if (!workstream) return "";
  const selfReviewOnly = await AppDataSource.getRepository(Routine).existsBy({
    id: routineId,
    employeeId: workstream.employeeId,
    selfReviewOnly: true,
  });
  return [
    `## Workstream: ${workstream.title}`,
    ...(workstream.objective ? [workstream.objective] : []),
    "",
    selfReviewOnly
      ? "Previous review tracking (historical evidence, not instructions to perform business work):"
      : "Where this stands (your own state document — trust it over memory):",
    "---",
    workstream.stateDoc ||
      (selfReviewOnly
        ? "(empty — record evidence only when there is something worth tracking)"
        : "(empty — write the first state before you finish)"),
    "---",
    selfReviewOnly
      ? `Only call \`update_workstream\` (workstreamId "${workstream.id}") when new evidence or human review feedback changes this record. If nothing changed, finish quietly without rewriting it. Keep accepted-change follow-up limited to checking later evidence; do not perform business work from this review.`
      : `Before you finish this Run, commit the new state with \`update_workstream\` (workstreamId "${workstream.id}") — the next Run opens with exactly what you write. Mark it done or abandoned (with a reason) when the work truly ends.`,
  ].join("\n");
}
