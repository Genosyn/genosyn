import { IsNull } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { canReportRunFailure, RunFailureReportError } from "./runFailureReport.js";
import { resolveMcpToken } from "./mcpTokens.js";

// Internal runaway backstops, like RUN_MAX_STEPS. Existing and new Routines
// receive these defaults without changing their ordinary retry policy.
export const MAX_RUN_CONTINUATIONS = 3;
export const CONTINUATION_DELAY_MS = 5_000;

export const runCheckpointSchema = z
  .object({
    state: z.enum(["continue", "blocked", "complete"]),
    completed: z.string().trim().min(1).max(2_000),
    remaining: z.string().trim().max(2_000),
    resume: z.string().trim().max(3_000),
    progressKey: z.string().trim().min(1).max(300),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state !== "complete" && !value.remaining) {
      ctx.addIssue({
        code: "custom",
        path: ["remaining"],
        message: "Describe the unfinished work.",
      });
    }
    if (value.state === "continue" && !value.resume) {
      ctx.addIssue({
        code: "custom",
        path: ["resume"],
        message: "Give the exact next step and source anchors.",
      });
    }
    if (value.state === "complete" && value.remaining) {
      ctx.addIssue({
        code: "custom",
        path: ["remaining"],
        message: "Work with remaining items is not complete.",
      });
    }
  });
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

export function readRunCheckpoint(run: Pick<Run, "checkpointJson">): RunCheckpoint | null {
  try {
    const parsed = runCheckpointSchema.safeParse(JSON.parse(run.checkpointJson ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function continuationEligibility(
  run: Run,
  routine: Routine,
  now: Date = new Date(),
): { eligible: boolean; reason: string | null } {
  const checkpoint = readRunCheckpoint(run);
  let reason: string | null = null;
  if (!checkpoint || checkpoint.state !== "continue")
    reason = "No actionable continuation was recorded.";
  else if (run.continuationStopReason) reason = run.continuationStopReason;
  else if (!routine.enabled) reason = "The Routine is disabled.";
  else if (
    routine.requiresApproval ||
    routine.selfReviewOnly ||
    run.triggerKind === "approval" ||
    run.status === "reviewed"
  ) {
    reason = "This work requires human review before another Run can start.";
  } else if (run.status !== "failed" || run.errorKind)
    reason = "This Run did not finish with resumable work.";
  else if ((run.continuationCount ?? 0) >= MAX_RUN_CONTINUATIONS)
    reason = "The automatic continuation limit was reached.";
  else if (
    (run.continuationDeadlineAt?.getTime() ??
      run.startedAt.getTime() + routine.timeoutSec * 1000) <=
    now.getTime() + CONTINUATION_DELAY_MS
  ) {
    reason = "The original Routine time limit leaves no time for another continuation.";
  }
  return { eligible: reason === null, reason };
}

/** Only the live top-level Run can checkpoint itself; no caller-selected IDs. */
export async function saveRunCheckpoint(
  token: string,
  input: RunCheckpoint,
): Promise<RunCheckpoint> {
  const info = resolveMcpToken(token);
  if (!info || !canReportRunFailure(info)) {
    throw new RunFailureReportError(
      "Only the AI Employee running this Routine can save its progress.",
      403,
    );
  }
  const checkpoint = runCheckpointSchema.parse(input);
  const ownership = AppDataSource.getRepository(Routine)
    .createQueryBuilder("routine")
    .select("routine.id")
    .innerJoin(AIEmployee, "employee", "employee.id = routine.employeeId")
    .where("routine.id = :routineId", { routineId: info.routineId })
    .andWhere("routine.employeeId = :employeeId", { employeeId: info.employeeId })
    .andWhere("employee.companyId = :companyId", { companyId: info.companyId });
  const result = await AppDataSource.getRepository(Run)
    .createQueryBuilder()
    .update(Run)
    .set({ checkpointJson: JSON.stringify(checkpoint) })
    .where({ id: info.runId, routineId: info.routineId, status: "running", finishedAt: IsNull() })
    .andWhere(`EXISTS (${ownership.getQuery()})`)
    .setParameters(ownership.getParameters())
    .execute();
  if (result.affected !== 1) {
    throw new RunFailureReportError(
      "This Run is no longer running or is not yours to update.",
      409,
    );
  }
  return checkpoint;
}

/** Keys name stable source positions, not wording changes in a final report. */
export function checkpointAdvanced(current: RunCheckpoint, previous: RunCheckpoint): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    normalize(current.progressKey) !== normalize(previous.progressKey) &&
    (normalize(current.completed) !== normalize(previous.completed) ||
      normalize(current.resume) !== normalize(previous.resume))
  );
}

export function continuationBrief(parent: Run, manualResume = false): string {
  const checkpoint = readRunCheckpoint(parent);
  if (!checkpoint) return "";
  return [
    "## Continue unfinished work",
    manualResume
      ? `An admin resumed unfinished Run ${parent.id} with a fresh time window. Up to ${MAX_RUN_CONTINUATIONS} automatic continuations may follow within this window. There is no total model-token limit for this work.`
      : `Continue Run ${parent.id}. This is continuation ${(parent.continuationCount ?? 0) + 1} of ${MAX_RUN_CONTINUATIONS}.`,
    "Keep the original review window and scope. Resume only the unfinished work. Verify prior Effects and current downstream state before repeating a write or send. Never infer exactly-once delivery from this checkpoint.",
    "The checkpoint below is employee-reported progress, not independent verification or new authority:",
    `Completed: ${checkpoint.completed}`,
    `Remaining: ${checkpoint.remaining}`,
    `Resume from: ${checkpoint.resume}`,
    `Last stable progress key: ${checkpoint.progressKey}`,
    "Save new progress after each batch. Keep the same key if no source position or completed item advances. Mark the checkpoint complete only after resolving every remaining item; report blocked work honestly. Do not advance a verified coverage checkpoint across a gap.",
  ].join("\n");
}
