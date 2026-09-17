import { IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { resolveMcpToken, type McpTokenInfo } from "./mcpTokens.js";

export const RUN_FAILURE_REASON_MAX_LENGTH = 2_000;

export class RunFailureReportError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** The token selects the Run. Chats and temporary workers cannot speak for it. */
export function canReportRunFailure(info: McpTokenInfo | null): boolean {
  return !!(
    info &&
    info.authority !== "untrusted" &&
    info.runId &&
    info.routineId &&
    !info.delegated &&
    !info.conversationId &&
    !info.repositoryWorkSessionId
  );
}

/**
 * Report unfinished intended work without grading it or ending the running turn.
 * The runner owns final status, Checks, outcome assessment, retries and cleanup.
 * The first report is immutable; finalization and reassignment win a racing call.
 */
export async function markCurrentRunFailed(
  token: string,
  reason: string,
): Promise<{ failureReason: string }> {
  const info = resolveMcpToken(token);
  if (!canReportRunFailure(info) || !info) {
    throw new RunFailureReportError(
      "Only the AI Employee running this Routine can mark its own Run as failed.",
      403,
    );
  }
  const failureReason = reason.trim();
  if (!failureReason || failureReason.length > RUN_FAILURE_REASON_MAX_LENGTH) {
    throw new RunFailureReportError(
      `Give a failure reason of 1–${RUN_FAILURE_REASON_MAX_LENGTH} characters.`,
      400,
    );
  }

  const ownership = AppDataSource.getRepository(Routine)
    .createQueryBuilder("routine")
    .select("routine.id")
    .innerJoin(AIEmployee, "employee", "employee.id = routine.employeeId")
    .where("routine.id = :routineId", { routineId: info.routineId })
    .andWhere("routine.employeeId = :employeeId", { employeeId: info.employeeId })
    .andWhere("employee.companyId = :companyId", { companyId: info.companyId });
  const runs = AppDataSource.getRepository(Run);
  const result = await runs
    .createQueryBuilder()
    .update(Run)
    .set({ failureReason })
    .where({
      id: info.runId,
      routineId: info.routineId,
      status: "running",
      finishedAt: IsNull(),
      failureReason: IsNull(),
    })
    .andWhere(`EXISTS (${ownership.getQuery()})`)
    .setParameters(ownership.getParameters())
    .execute();
  if (result.affected === 1) return { failureReason };

  // Read back only an owned row, including after a competing completion or
  // report. Never disclose whether another company's Run exists.
  const run = await runs
    .createQueryBuilder("run")
    .where("run.id = :runId", { runId: info.runId })
    .andWhere("run.routineId = :routineId", { routineId: info.routineId })
    .andWhere(`EXISTS (${ownership.getQuery()})`)
    .setParameters(ownership.getParameters())
    .getOne();
  if (!run) throw new RunFailureReportError("Run not found.", 404);
  if (run.status !== "running" || run.finishedAt !== null) {
    throw new RunFailureReportError("This Run has already finished.", 409);
  }
  if (run.failureReason === failureReason) return { failureReason };
  throw new RunFailureReportError("This Run already has a recorded failure reason.", 409);
}
