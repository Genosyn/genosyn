import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { Workstream } from "../../db/entities/Workstream.js";
import { UUID_RE } from "../bases.js";
import { WorkstreamError } from "../workstreams.js";

export interface OwnReviewContext {
  companyId: string;
  employeeId: string;
  routineId?: string | null;
  runId?: string | null;
}

/** A token flag alone is not evidence of a currently running review. */
export async function isActiveOwnReview(context: OwnReviewContext): Promise<boolean> {
  if (
    !context.routineId ||
    !context.runId ||
    !UUID_RE.test(context.routineId) ||
    !UUID_RE.test(context.runId)
  )
    return false;
  const [employee, routine, run] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: context.employeeId,
      companyId: context.companyId,
    }),
    AppDataSource.getRepository(Routine).findOneBy({
      id: context.routineId,
      employeeId: context.employeeId,
      selfReviewOnly: true,
    }),
    AppDataSource.getRepository(Run).findOneBy({
      id: context.runId,
      routineId: context.routineId,
      status: "running",
    }),
  ]);
  return !!employee && !!routine && !!run && run.finishedAt === null;
}

/** The only writable progress record belongs to this exact review Routine. */
export async function reviewTrackingRoutine(
  context: OwnReviewContext,
  requestedRoutineId?: string,
  workstreamId?: string,
): Promise<string> {
  if (!(await isActiveOwnReview(context))) {
    throw new WorkstreamError("This review is no longer running.");
  }
  const routineId = context.routineId!;
  if (requestedRoutineId && requestedRoutineId !== routineId) {
    throw new WorkstreamError("This review can track only its own Routine.");
  }
  if (workstreamId) {
    const workstream = await AppDataSource.getRepository(Workstream).findOneBy({
      id: workstreamId,
      companyId: context.companyId,
      employeeId: context.employeeId,
      routineId,
    });
    if (!workstream) {
      throw new WorkstreamError("This review can update only its own bound Workstream.");
    }
  }
  return routineId;
}
