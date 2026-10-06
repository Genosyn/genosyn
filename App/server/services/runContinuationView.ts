import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { readRunCheckpoint } from "./runContinuation.js";

type ContinuationSource = Pick<
  Run,
  "checkpointJson" | "retryAt" | "continuationCount" | "continuationStopReason"
>;

const followUpFields = [
  "id",
  "routineId",
  "parentRunId",
  "status",
  "errorKind",
  "createdAt",
  "startedAt",
  "finishedAt",
  "exitCode",
  "triggerKind",
  "continuationCount",
  "retryAt",
  "outcomeVerdict",
] as const satisfies readonly (keyof Run)[];

export type RunFollowUp = Pick<
  Run,
  | "id"
  | "routineId"
  | "status"
  | "errorKind"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "exitCode"
  | "triggerKind"
  | "continuationCount"
> & {
  /** A follow-up is still owed by this related Run, not by the selected parent. */
  retryPending: boolean;
  awaitingOutcome: boolean;
  /** False if a bounded or ambiguous relationship prevents identifying the latest Run. */
  isLatest: boolean;
};

/**
 * Follow only durable, same-Routine relationships after the caller authorizes
 * the source Runs. Recheck current company ownership on every metadata query.
 * Batch each depth across history rows; never load transcripts or checkpoints.
 */
export async function loadRunFollowUps(
  companyId: string,
  runs: Pick<Run, "id" | "routineId">[],
): Promise<Map<string, RunFollowUp | null>> {
  const nodes = new Map(runs.map((run) => [run.id, run]));
  const children = new Map<string, Run[]>();
  const awaitingOutcome = new Set<string>();
  let frontier = runs;
  for (let depth = 0; depth < 20 && frontier.length; depth++) {
    const { entities: rows, raw } = await AppDataSource.getRepository(Run)
      .createQueryBuilder("run")
      .select(followUpFields.map((field) => `run.${field}`))
      .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
      .innerJoin(AIEmployee, "owner", "CAST(owner.id AS text) = routine.employeeId")
      .addSelect("run.id", "followUpId")
      .addSelect("routine.acceptanceCriteria", "followUpCriteria")
      .where("owner.companyId = :companyId", { companyId })
      .andWhere("run.routineId IN (:...routineIds)", {
        routineIds: [...new Set(frontier.map((run) => run.routineId))],
      })
      .andWhere("run.parentRunId IN (:...parentIds)", { parentIds: frontier.map((run) => run.id) })
      .orderBy("run.createdAt", "DESC")
      .addOrderBy("run.id", "DESC")
      .getRawAndEntities<{ followUpId: string; followUpCriteria: string | null }>();
    const criteria = new Map(raw.map((row) => [row.followUpId, row.followUpCriteria]));
    for (const parent of frontier) children.set(parent.id, []);
    const next: Run[] = [];
    for (const row of rows) {
      const parent = row.parentRunId ? nodes.get(row.parentRunId) : undefined;
      if (!parent || row.routineId !== parent.routineId) continue;
      if (row.status === "completed" && !row.outcomeVerdict && criteria.get(row.id)?.trim())
        awaitingOutcome.add(row.id);
      children.get(parent.id)!.push(row);
      if (!nodes.has(row.id)) next.push(row);
      nodes.set(row.id, row);
    }
    frontier = next;
  }
  const views = new Map<string, RunFollowUp | null>();
  for (const source of runs) {
    let cursor = source;
    let followUp: Run | null = null;
    const seen = new Set([source.id]);
    let isLatest = true;
    for (;;) {
      const candidates = children.get(cursor.id);
      if (!candidates) {
        isLatest = false;
        break;
      }
      if (!candidates.length) break;
      const child = candidates[0];
      if (seen.has(child.id)) {
        followUp ??= child;
        isLatest = false;
        break;
      }
      followUp = child;
      if (candidates.length !== 1) {
        isLatest = false;
        break;
      }
      seen.add(child.id);
      cursor = child;
    }
    views.set(
      source.id,
      followUp
        ? {
            id: followUp.id,
            routineId: followUp.routineId,
            status: followUp.status,
            errorKind: followUp.errorKind,
            createdAt: followUp.createdAt,
            startedAt: followUp.startedAt,
            finishedAt: followUp.finishedAt,
            exitCode: followUp.exitCode,
            triggerKind: followUp.triggerKind,
            continuationCount: followUp.continuationCount,
            retryPending: !!followUp.retryAt,
            awaitingOutcome: awaitingOutcome.has(followUp.id),
            isLatest,
          }
        : null,
    );
  }
  return views;
}

/** Progress bodies stay private; Run views receive only scheduling metadata. */
export function runContinuationView(run: ContinuationSource, followUpRun?: RunFollowUp | null) {
  return {
    hasUnfinishedWork: readRunCheckpoint(run)?.state === "continue",
    continuationPending: !!run.retryAt && readRunCheckpoint(run)?.state === "continue",
    continuationCount: run.continuationCount ?? 0,
    followUpRun,
    continuationStopReason: run.continuationStopReason
      ? redactSensitiveText(run.continuationStopReason).slice(0, 2000)
      : null,
  };
}

/** Never leak the saved checkpoint through a route that returns a Run row. */
export function publicRun(run: Run, followUpRun?: RunFollowUp | null) {
  const {
    checkpointJson: _checkpointJson,
    continuationDeadlineAt: _continuationDeadlineAt,
    continuationTokensUsed: _continuationTokensUsed,
    continuationOriginTriggerKind: _continuationOriginTriggerKind,
    continuationReviewOnly: _continuationReviewOnly,
    diagnosticsJson: _diagnosticsJson,
    requiredToolsJson: _requiredToolsJson,
    queueOptionsJson: _queueOptionsJson,
    queueActiveEmployeeId: _queueActiveEmployeeId,
    ...visible
  } = run;
  return { ...visible, queuedAt: run.createdAt, ...runContinuationView(run, followUpRun) };
}
