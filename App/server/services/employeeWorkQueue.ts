import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunTrigger } from "../db/entities/Run.js";
import {
  DEFAULT_ROUTINE_PRIORITY,
  isRoutinePriority,
  type RoutinePriority,
} from "../../shared/routinePriority.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { readRunCheckpoint } from "./runContinuation.js";
import { anyRetryAt, isRetryDispatchClaimed } from "./runRecovery.js";
import { claimedRuns, companyRunQueue } from "./routineQueueOrder.js";
import { workBlocked } from "./standdowns.js";

const QUEUE_PREVIEW_LIMIT = 100;

export type EmployeeQueueItem = {
  id: string;
  runId: string | null;
  routine: { id: string; name: string; slug: string };
  /** The Routine's priority: a High Routine's waiting Runs start before Normal ones. */
  priority: RoutinePriority;
  triggerKind: RunTrigger;
  queuedAt: string;
  availableAt: string | null;
  /**
   * Its place in the company's queue of Runs waiting to start, 1 being next
   * up — the order the queue offers them to their AI Models. Null for a Run
   * already running, a follow-up scheduled for later, and work a Standdown
   * holds.
   */
  position: number | null;
  blockedReason: string | null;
};

export type EmployeeWorkQueue = {
  employeeId: string;
  /** First running item retained for older API clients. */
  current: EmployeeQueueItem | null;
  running: EmployeeQueueItem[];
  runningCount: number;
  pending: EmployeeQueueItem[];
  pendingCount: number;
};

/** What an item shows about a Run; never its options, checkpoint body or transcript. */
const ITEM_FIELDS = {
  id: true,
  routineId: true,
  employeeId: true,
  status: true,
  triggerKind: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  retryAt: true,
  checkpointJson: true,
  continuationCount: true,
  continuationStopReason: true,
} as const;

/**
 * Read active and deferred Routine work independently of the selected day. Only
 * public scheduling metadata crosses this boundary: replay options, approval
 * authority, checkpoints and transcripts never leave the server.
 *
 * Every read is bounded by an index to work that is active or waiting — the
 * Runs that are running or hold a claim, the company's queue, the Runs owed a
 * follow-up — and then narrowed to this employee in memory. Narrowing by the
 * employee's Routines first would walk each one's whole Run history to find
 * the few that are live (AGENTS.md §7).
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
    select: { id: true, name: true, slug: true, priority: true },
  });
  const routineById = new Map(routines.map((routine) => [routine.id, routine]));
  // A Run counts as this employee's when its Routine is theirs now and the Run
  // is not one a reassigned Routine left behind with its previous owner.
  const isTheirs = (run: Pick<Run, "routineId" | "employeeId">) =>
    routineById.has(run.routineId) && (run.employeeId === null || run.employeeId === employeeId);

  const runs = AppDataSource.getRepository(Run);
  const [runningRows, claims, line, owedRows] = await Promise.all([
    runs.find({ where: { status: "running" }, select: ITEM_FIELDS }),
    claimedRuns(),
    companyRunQueue(companyId),
    runs.find({ where: { retryAt: anyRetryAt() }, select: ITEM_FIELDS }),
  ]);

  // Running, or finished and still assessing under its claim.
  const claimedIds = claims.filter((run) => routineById.has(run.routineId)).map((run) => run.id);
  const runningIds = new Set(runningRows.map((run) => run.id));
  const assessing = claimedIds.filter((id) => !runningIds.has(id));
  const active = [
    ...runningRows,
    ...(assessing.length
      ? await runs.find({ where: { id: In(assessing) }, select: ITEM_FIELDS })
      : []),
  ]
    .filter(isTheirs)
    .sort(
      (a, b) =>
        a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const claimedSet = new Set(claimedIds);

  // Waiting to start, in the queue's order, with each Run's place in it.
  const waiting = line.filter((run) => isTheirs(run) && !claimedSet.has(run.id));
  const waitingRows = new Map(
    (waiting.length
      ? await runs.find({
          where: { id: In(waiting.slice(0, QUEUE_PREVIEW_LIMIT).map((run) => run.id)) },
          select: ITEM_FIELDS,
        })
      : []
    ).map((run) => [run.id, run]),
  );

  // Owed a retry or a continuation that has not been queued as a Run yet. A
  // child replaces its follow-up at dispatch: never show its parent's
  // temporary retry claim as a second pending occurrence.
  const owed = owedRows.filter(
    (run) => isTheirs(run) && run.status !== "queued" && run.status !== "running",
  );
  const children = owed.length
    ? await runs.find({
        where: { parentRunId: In(owed.map((run) => run.id)) },
        select: { id: true, parentRunId: true, routineId: true },
      })
    : [];
  const replaced = new Set(
    children
      .filter((child) =>
        owed.some(
          (parent) => parent.id === child.parentRunId && parent.routineId === child.routineId,
        ),
      )
      .map((child) => child.parentRunId),
  );
  const followUps = owed
    .filter((run) => !replaced.has(run.id))
    .sort(
      (a, b) =>
        (a.retryAt?.getTime() ?? 0) - (b.retryAt?.getTime() ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  function item(run: Run, options: { followUp?: boolean; position?: number | null } = {}) {
    const followUp = options.followUp ?? false;
    const routine = routineById.get(run.routineId);
    if (!routine) return null;
    const stopped = workBlocked(companyId, { employeeId, routineId: routine.id });
    const checkpoint = followUp ? readRunCheckpoint(run) : null;
    const continuation =
      followUp &&
      (checkpoint?.state === "continue" ||
        checkpoint?.state === "blocked" ||
        run.triggerKind === "continuation" ||
        run.continuationCount > 0 ||
        Boolean(run.continuationStopReason));
    const entry: EmployeeQueueItem = {
      id: followUp ? `follow-up:${run.id}` : run.id,
      runId: followUp ? null : run.id,
      routine: { id: routine.id, name: routine.name, slug: routine.slug },
      priority: isRoutinePriority(routine.priority) ? routine.priority : DEFAULT_ROUTINE_PRIORITY,
      triggerKind: followUp ? (continuation ? "continuation" : "retry") : run.triggerKind,
      queuedAt: (followUp ? (run.finishedAt ?? run.createdAt) : run.createdAt).toISOString(),
      availableAt:
        followUp && run.retryAt && !isRetryDispatchClaimed(run.retryAt)
          ? run.retryAt.toISOString()
          : null,
      position: options.position ?? null,
      blockedReason: stopped.blocked ? redactSensitiveText(`Stood down: ${stopped.reason}`) : null,
    };
    return entry;
  }

  const running = active
    .slice(0, QUEUE_PREVIEW_LIMIT)
    .map((run) => item(run))
    .filter((entry): entry is EmployeeQueueItem => entry !== null);
  const pending = [
    ...waiting.slice(0, QUEUE_PREVIEW_LIMIT).map((run) => {
      const row = waitingRows.get(run.id);
      return row ? item(row, { position: run.position }) : null;
    }),
    ...followUps.slice(0, QUEUE_PREVIEW_LIMIT).map((run) => item(run, { followUp: true })),
  ]
    .filter((entry): entry is EmployeeQueueItem => entry !== null)
    .slice(0, QUEUE_PREVIEW_LIMIT);

  return {
    employeeId,
    current: running[0] ?? null,
    running,
    runningCount: active.length,
    pending,
    pendingCount: waiting.length + followUps.length,
  };
}
