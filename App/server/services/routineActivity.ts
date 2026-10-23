import { SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { loadRunFollowUps, runContinuationView, type RunFollowUp } from "./runContinuationView.js";

export const ROUTINE_ACTIVITY_MAX_WINDOW_MS = 26 * 60 * 60 * 1000;

/** Waiting Runs listed at once; `queuedCount` still counts every one. */
export const ROUTINE_ACTIVITY_QUEUED_LIMIT = 100;

const runSummaryFields = [
  "id",
  "routineId",
  "status",
  "errorKind",
  "startedAt",
  "finishedAt",
  "exitCode",
  "attempt",
  "retryAt",
  "continuationCount",
  "continuationStopReason",
  "missedSlots",
  "outcomeVerdict",
  "checksVerdict",
] as const satisfies readonly (keyof Run)[];

export type RoutineActivityRun = Pick<Run, (typeof runSummaryFields)[number]> & {
  hasUnfinishedWork: boolean;
  continuationPending: boolean;
  followUpRun?: RunFollowUp | null;
};

/**
 * A Run waiting to start. A Run paused for a restart waits here too, keeping
 * its pause so it reads as resuming rather than as new work.
 */
export type RoutineActivityQueuedRun = RoutineActivityRun &
  Pick<Run, "pauseCount" | "pausedAt"> & { queuedAt: Date };

export type RoutineActivity = {
  running: RoutineActivityRun[];
  queued: RoutineActivityQueuedRun[];
  queuedCount: number;
  today: { routineId: string; runCount: number; latestRun: RoutineActivityRun }[];
};

/** Scope through the Routine's current owner, including on the hydration query. */
function companyRuns(companyId: string): SelectQueryBuilder<Run> {
  return (
    AppDataSource.getRepository(Run)
      .createQueryBuilder("run")
      // IDs are UUID columns on Postgres, while the reference columns are varchar.
      .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
      .innerJoin(AIEmployee, "owner", "CAST(owner.id AS text) = routine.employeeId")
      .where("owner.companyId = :companyId", { companyId })
  );
}

/**
 * A Run that crossed midnight belongs to the day it finished as well as the
 * day it started. A skipped tick did no work; active work has its own section.
 */
function inDay(alias: string): string {
  return (
    `${alias}.status NOT IN (:...excludedStatuses) AND (` +
    `(${alias}.startedAt >= :from AND ${alias}.startedAt < :to) OR ` +
    `(${alias}.finishedAt >= :from AND ${alias}.finishedAt < :to))`
  );
}

function summary(run: Run, followUpRun: RunFollowUp | null): RoutineActivityRun {
  return {
    id: run.id,
    routineId: run.routineId,
    status: run.status,
    errorKind: run.errorKind,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    attempt: run.attempt,
    retryAt: run.retryAt,
    ...runContinuationView(run, followUpRun),
    missedSlots: run.missedSlots,
    outcomeVerdict: run.outcomeVerdict,
    checksVerdict: run.checksVerdict,
  };
}

function queuedSummary(run: Run): RoutineActivityQueuedRun {
  return {
    // Nothing follows a Run that has not started yet.
    ...summary(run, null),
    queuedAt: run.createdAt,
    pauseCount: run.pauseCount,
    pausedAt: run.pausedAt,
  };
}

/**
 * The Routines overview needs all active work, the Runs waiting to start, and
 * one latest Run per Routine for a local calendar day. Count and choose the
 * latest ID in the database, then hydrate only those summaries: history and
 * transcripts never enter the response or application memory. Every query
 * stays company-scoped.
 */
export async function getRoutineActivity({
  companyId,
  from,
  to,
}: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<RoutineActivity> {
  const selectedFields = [...runSummaryFields, "checkpointJson"].map((field) => `run.${field}`);
  const dayParameters = { from, to, excludedStatuses: ["queued", "running", "skipped"] };
  const [running, [queued, queuedCount], daily] = await Promise.all([
    companyRuns(companyId)
      .select(selectedFields)
      .andWhere("run.status = :running", { running: "running" })
      .orderBy("run.startedAt", "DESC")
      .addOrderBy("run.id", "DESC")
      .getMany(),
    // Oldest first, for display only: each AI Model admits its own waiting
    // Runs, so this is not the order every one of them will start in.
    companyRuns(companyId)
      .select([...selectedFields, "run.createdAt", "run.pauseCount", "run.pausedAt"])
      .andWhere("run.status = :queued", { queued: "queued" })
      .orderBy("run.createdAt", "ASC")
      .addOrderBy("run.id", "ASC")
      .take(ROUTINE_ACTIVITY_QUEUED_LIMIT)
      .getManyAndCount(),
    companyRuns(companyId)
      .select("run.routineId", "routineId")
      .addSelect("COUNT(*)", "runCount")
      .addSelect(
        (query) =>
          query
            .subQuery()
            .select("latest.id")
            .from(Run, "latest")
            .where("latest.routineId = run.routineId")
            .andWhere(inDay("latest"))
            .orderBy("COALESCE(latest.finishedAt, latest.startedAt)", "DESC")
            .addOrderBy("latest.id", "DESC")
            .limit(1),
        "latestRunId",
      )
      .andWhere(inDay("run"), dayParameters)
      .groupBy("run.routineId")
      .getRawMany<{ routineId: string; runCount: string | number; latestRunId: string }>(),
  ]);

  const latestRuns = daily.length
    ? await companyRuns(companyId)
        .select(selectedFields)
        .andWhere("run.id IN (:...latestRunIds)", {
          latestRunIds: daily.map((row) => row.latestRunId),
        })
        .andWhere(inDay("run"), dayParameters)
        .getMany()
    : [];
  const byId = new Map(latestRuns.map((run) => [run.id, run]));
  const followUps = await loadRunFollowUps(companyId, [...running, ...latestRuns]);
  const today: RoutineActivity["today"] = [];
  for (const row of daily) {
    const latestRun = byId.get(row.latestRunId);
    // A Routine or Run can be deleted while the overview is loading.
    if (latestRun) {
      today.push({
        routineId: row.routineId,
        runCount: Number(row.runCount),
        latestRun: summary(latestRun, followUps.get(latestRun.id) ?? null),
      });
    }
  }
  today.sort((a, b) => {
    const aTime = (a.latestRun.finishedAt ?? a.latestRun.startedAt).getTime();
    const bTime = (b.latestRun.finishedAt ?? b.latestRun.startedAt).getTime();
    return bTime - aTime || b.latestRun.id.localeCompare(a.latestRun.id);
  });
  return {
    running: running.map((run) => summary(run, followUps.get(run.id) ?? null)),
    queued: queued.map(queuedSummary),
    queuedCount,
    today,
  };
}
