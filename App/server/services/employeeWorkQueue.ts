import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunTrigger } from "../db/entities/Run.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { readRunCheckpoint } from "./runContinuation.js";
import { isRetryDispatchClaimed } from "./runRecovery.js";
import { workBlocked } from "./standdowns.js";

const QUEUE_PREVIEW_LIMIT = 100;

export type EmployeeQueueItem = {
  id: string;
  runId: string | null;
  routine: { id: string; name: string; slug: string };
  triggerKind: RunTrigger;
  queuedAt: string;
  availableAt: string | null;
  position: number | null;
  blockedReason: string | null;
};

export type EmployeeWorkQueue = {
  employeeId: string;
  current: EmployeeQueueItem | null;
  pending: EmployeeQueueItem[];
  pendingCount: number;
};

/**
 * Read the durable queue independently of the calendar's selected day. Only
 * public scheduling metadata crosses this boundary: replay options, approval
 * authority, checkpoints and transcripts never leave the server.
 */
export async function getEmployeeWorkQueue(
  companyId: string,
  employeeId: string,
): Promise<EmployeeWorkQueue | null> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) return null;

  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId },
    select: ["id", "name", "slug"],
  });
  const routineById = new Map(routines.map((routine) => [routine.id, routine]));
  const query = () =>
    AppDataSource.getRepository(Run)
      .createQueryBuilder("run")
      .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
      .where("routine.employeeId = :employeeId", { employeeId })
      .andWhere("(run.employeeId IS NULL OR run.employeeId = :employeeId)")
      .select([
        "run.id",
        "run.routineId",
        "run.triggerKind",
        "run.createdAt",
        "run.finishedAt",
        "run.retryAt",
        "run.checkpointJson",
        "run.continuationCount",
        "run.continuationStopReason",
      ]);

  const [currentRun, [queued, queuedCount], [retries, retryCount]] = await Promise.all([
    query()
      .andWhere("(run.status = :running OR run.queueActiveEmployeeId = :employeeId)", {
        running: "running",
      })
      .orderBy("run.startedAt", "ASC")
      .addOrderBy("run.id", "ASC")
      .getOne(),
    query()
      .andWhere("run.status = :queued AND run.queueActiveEmployeeId IS NULL", { queued: "queued" })
      .orderBy("run.createdAt", "ASC")
      .addOrderBy("run.id", "ASC")
      .take(QUEUE_PREVIEW_LIMIT)
      .getManyAndCount(),
    query()
      .andWhere("run.status NOT IN (:...active) AND run.retryAt IS NOT NULL", {
        active: ["queued", "running"],
      })
      // A child takes over the queue position at dispatch. Never show its
      // parent's temporary retry claim as a second pending occurrence.
      .andWhere((qb) => {
        const child = qb
          .subQuery()
          .select("1")
          .from(Run, "child")
          .where("child.parentRunId = CAST(run.id AS text) AND child.routineId = run.routineId")
          .getQuery();
        return `NOT EXISTS ${child}`;
      })
      .orderBy("run.retryAt", "ASC")
      .addOrderBy("run.id", "ASC")
      .take(QUEUE_PREVIEW_LIMIT)
      .getManyAndCount(),
  ]);

  function item(run: Run, followUp = false): EmployeeQueueItem | null {
    const routine = routineById.get(run.routineId);
    if (!routine) return null;
    const stopped = workBlocked(companyId, { employeeId, routineId: routine.id });
    const checkpoint = followUp ? readRunCheckpoint(run) : null;
    const continuation = followUp && (
      checkpoint?.state === "continue" ||
      checkpoint?.state === "blocked" ||
      run.triggerKind === "continuation" ||
      run.continuationCount > 0 ||
      Boolean(run.continuationStopReason)
    );
    return {
      id: followUp ? `follow-up:${run.id}` : run.id,
      runId: followUp ? null : run.id,
      routine: { id: routine.id, name: routine.name, slug: routine.slug },
      triggerKind: followUp ? (continuation ? "continuation" : "retry") : run.triggerKind,
      queuedAt: (followUp ? run.finishedAt ?? run.createdAt : run.createdAt).toISOString(),
      availableAt:
        followUp && run.retryAt && !isRetryDispatchClaimed(run.retryAt)
          ? run.retryAt.toISOString()
          : null,
      position: null,
      blockedReason: stopped.blocked
        ? redactSensitiveText(`Stood down: ${stopped.reason}`)
        : null,
    };
  }

  // Ready requests retain their durable FIFO order. Delayed retries have not
  // joined that order yet, and follow it until the scheduler enqueues them.
  const pending = [...queued.map((run) => item(run)), ...retries.map((run) => item(run, true))]
    .filter((entry): entry is EmployeeQueueItem => entry !== null)
    .slice(0, QUEUE_PREVIEW_LIMIT)
    .map((entry, index) => ({ ...entry, position: index + 1 }));

  return {
    employeeId,
    current: currentRun ? item(currentRun) : null,
    pending,
    pendingCount: queuedCount + retryCount,
  };
}
