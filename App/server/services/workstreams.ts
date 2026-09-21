import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream, type WorkstreamStatus } from "../db/entities/Workstream.js";
// The shared uuid-PK guard — see routineFolders.ts for the Postgres 22P02 story.
import { UUID_RE } from "./bases.js";
import { recordAudit } from "./audit.js";

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

export async function createWorkstream(args: {
  companyId: string;
  employeeId: string;
  title: string;
  objective?: string;
  stateDoc?: string;
  routineId?: string | null;
  /** Internal: business Runs cannot bind suggestion-only review Routines. */
  excludeSelfReviews?: boolean;
}): Promise<Workstream> {
  const title = args.title.trim();
  if (!title) throw new WorkstreamError("A workstream needs a title");
  const repo = AppDataSource.getRepository(Workstream);
  const active = await repo.countBy({ employeeId: args.employeeId, status: "active" });
  if (active >= ACTIVE_PER_EMPLOYEE_MAX) {
    throw new WorkstreamError(
      `You already carry ${active} active workstreams — finish or abandon one first`,
    );
  }
  if (args.routineId) {
    await assertBindableRoutine(args.employeeId, args.routineId, args.excludeSelfReviews);
  }
  return repo.save(
    repo.create({
      companyId: args.companyId,
      employeeId: args.employeeId,
      title: title.slice(0, 140),
      objective: (args.objective ?? "").trim().slice(0, 4_000),
      stateDoc: (args.stateDoc ?? "").slice(0, STATE_DOC_MAX),
      routineId: args.routineId ?? null,
    }),
  );
}

async function assertBindableRoutine(
  employeeId: string,
  routineId: string,
  excludeSelfReviews = false,
): Promise<void> {
  if (!UUID_RE.test(routineId)) throw new WorkstreamError("That routine is not yours to bind");
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: routineId,
    employeeId,
  });
  if (!routine) throw new WorkstreamError("That routine is not yours to bind");
  if (excludeSelfReviews && routine.selfReviewOnly) {
    throw new WorkstreamError("A self-review Routine cannot carry background business work");
  }
  const bound = await AppDataSource.getRepository(Workstream).countBy({
    routineId,
    status: "active",
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
}): Promise<Workstream> {
  if (!UUID_RE.test(args.workstreamId)) throw new WorkstreamError("Workstream not found");
  const repo = AppDataSource.getRepository(Workstream);
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
  if (args.stateDoc !== undefined) {
    workstream.stateDoc = args.stateDoc.slice(0, STATE_DOC_MAX);
  }
  if (args.routineId !== undefined) {
    if (args.routineId) await assertBindableRoutine(args.employeeId, args.routineId);
    workstream.routineId = args.routineId;
  }
  if (args.status !== undefined && args.status !== workstream.status) {
    if (args.status === "abandoned" && !(args.closeReason ?? "").trim()) {
      throw new WorkstreamError("Abandoning needs a reason — work never just evaporates");
    }
    workstream.status = args.status;
    workstream.closeReason =
      args.status === "active" ? "" : (args.closeReason ?? "").trim().slice(0, 2_000);
  }
  if (args.lastRunId !== undefined) workstream.lastRunId = args.lastRunId;
  return repo.save(workstream);
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
  if (filter.excludeSelfReviews) {
    // Filter before the limit. Orphaned bindings stay withheld too: deleting a
    // review Routine must not turn its historical tracking into business work.
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
  return query.orderBy("workstream.updatedAt", "DESC").addOrderBy("workstream.id", "DESC");
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
  return {
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
