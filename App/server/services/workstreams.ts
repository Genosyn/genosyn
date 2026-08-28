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
  if (args.routineId) await assertBindableRoutine(args.employeeId, args.routineId);
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

async function assertBindableRoutine(employeeId: string, routineId: string): Promise<void> {
  if (!UUID_RE.test(routineId)) throw new WorkstreamError("That routine is not yours to bind");
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: routineId,
    employeeId,
  });
  if (!routine) throw new WorkstreamError("That routine is not yours to bind");
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
    throw new WorkstreamError(`This workstream is ${workstream.status}; reopen it explicitly first`);
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

export async function listWorkstreams(
  companyId: string,
  filter: { employeeId?: string; status?: WorkstreamStatus } = {},
): Promise<Workstream[]> {
  return AppDataSource.getRepository(Workstream).find({
    where: {
      companyId,
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    order: { updatedAt: "DESC" },
    take: 200,
  });
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
  return [
    `## Workstream: ${workstream.title}`,
    ...(workstream.objective ? [workstream.objective] : []),
    "",
    "Where this stands (your own state document — trust it over memory):",
    "---",
    workstream.stateDoc || "(empty — write the first state before you finish)",
    "---",
    `Before you finish this Run, commit the new state with \`update_workstream\` (workstreamId "${workstream.id}") — the next Run opens with exactly what you write. Mark it done or abandoned (with a reason) when the work truly ends.`,
  ].join("\n");
}
