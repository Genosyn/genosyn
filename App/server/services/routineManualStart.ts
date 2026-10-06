import { IsNull, Not, type EntityManager } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { browserRunCreationBlocked } from "./browserRecordings.js";
import { routineNeedsWorkReview } from "./proactive/policy.js";
import { StanddownError, workBlocked } from "./standdowns.js";

export class ManualRoutineStartError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ManualRoutineStartError";
  }
}

const acceptanceTails = new Map<string, Promise<void>>();

async function currentRoutine(
  manager: EntityManager,
  target: { routineId: string; employeeId: string | null },
  companyId: string,
  lock: boolean,
): Promise<Routine> {
  const routine = await manager.getRepository(Routine).findOne({
    where: { id: target.routineId },
    ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  const employee = routine
    ? await manager.getRepository(AIEmployee).findOneBy({ id: routine.employeeId, companyId })
    : null;
  if (!routine || !employee || routine.employeeId !== target.employeeId)
    throw new ManualRoutineStartError("Routine not found.", 404);
  const authority = { companyId, employeeId: employee.id, routineId: routine.id };
  if (browserRunCreationBlocked(authority))
    throw new ManualRoutineStartError("This Routine is being removed.", 409);
  const stopped = workBlocked(companyId, authority);
  if (stopped.blocked)
    throw new StanddownError(`AI work is stood down for this ${stopped.scope}: ${stopped.reason}`);
  return routine;
}

async function existingRun(manager: EntityManager, routineId: string): Promise<Run | null> {
  const runs = manager.getRepository(Run);
  // Prefer the actual owner (including terminal cleanup) over queued siblings
  // left by older versions. Returning it must not register another waiter.
  const order = { createdAt: "ASC", id: "ASC" } as const;
  const owned = await runs.findOne({
    where: [
      { routineId, queueActiveEmployeeId: Not(IsNull()) },
      { routineId, status: "running" },
    ],
    order,
  });
  return owned ?? runs.findOne({ where: { routineId, status: "queued" }, order });
}

/** Reopening accepted work needs no model or Skill preparation. Insertion rechecks atomically. */
export async function findAcceptedManualRoutineRun(
  routine: Routine,
  companyId: string,
): Promise<Run | null> {
  const current = await currentRoutine(
    AppDataSource.manager,
    { routineId: routine.id, employeeId: routine.employeeId },
    companyId,
    false,
  );
  return existingRun(AppDataSource.manager, current.id);
}

/** A failed acceptance never poisons the next request or releases its successor's lock. */
async function withAcceptanceLock<T>(routineId: string, accept: () => Promise<T>): Promise<T> {
  const previous = acceptanceTails.get(routineId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  acceptanceTails.set(routineId, tail);
  await previous;
  try {
    return await accept();
  } finally {
    release();
    if (acceptanceTails.get(routineId) === tail) acceptanceTails.delete(routineId);
  }
}

/**
 * Direct Member requests reuse accepted work after an uncertain HTTP response.
 * Only the final check/insert is locked; preparation and dispatch stay outside
 * the transaction. Scheduled, approved and resumed acceptance keep their own
 * occurrence semantics and never call this helper.
 */
export async function persistManualRoutineRun(
  candidate: Run,
  companyId: string,
): Promise<{ run: Run; created: boolean }> {
  return withAcceptanceLock(candidate.routineId, async () => {
    const accept = async (manager: EntityManager) => {
      const routine = await currentRoutine(
        manager,
        candidate,
        companyId,
        config.db.driver === "postgres",
      );
      const existing = await existingRun(manager, routine.id);
      if (existing) return { run: existing, created: false };

      // Capture restrictions that changed during preparation without saving the
      // caller's stale Routine object or relaxing already captured restrictions.
      candidate.continuationReviewOnly ||= routineNeedsWorkReview(routine, "manual");
      const options = JSON.parse(candidate.queueOptionsJson ?? "{}") as {
        queuePolicy?: Pick<Routine, "selfReviewOnly" | "mailDeliveryMode">;
      };
      candidate.queueOptionsJson = JSON.stringify({
        ...options,
        queuePolicy: {
          selfReviewOnly: !!options.queuePolicy?.selfReviewOnly || routine.selfReviewOnly,
          mailDeliveryMode:
            routine.mailDeliveryMode ?? options.queuePolicy?.mailDeliveryMode ?? null,
        },
      });
      return { run: await manager.getRepository(Run).save(candidate), created: true };
    };
    return config.db.driver === "postgres"
      ? AppDataSource.transaction("READ COMMITTED", accept)
      : accept(AppDataSource.manager);
  });
}
