import { EntityManager, In, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { Run } from "../db/entities/Run.js";
import { Routine } from "../db/entities/Routine.js";
import { config } from "../../config.js";

export class WorkloadLimitError extends Error {
  readonly status = 429;

  constructor() {
    super("This company has reached its concurrent AI workload limit. Try again shortly.");
    this.name = "WorkloadLimitError";
  }
}

export class EmployeeWorkloadBusyError extends Error {
  readonly status = 409;

  constructor() {
    super("This AI employee is already working. Wait for the current Run or chat to finish.");
    this.name = "EmployeeWorkloadBusyError";
  }
}

let sqliteQueue: Promise<void> = Promise.resolve();

async function sqliteExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = sqliteQueue;
  let release!: () => void;
  sqliteQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function acquireWithManager(
  manager: EntityManager,
  companyId: string,
  employeeId: string,
  kind: "chat" | "routine",
  ttlMs: number,
): Promise<WorkloadLease> {
  const companyRepo = manager.getRepository(Company);
  if (config.db.driver === "postgres") {
    await companyRepo.findOneOrFail({
      where: { id: companyId },
      lock: { mode: "pessimistic_write" },
    });
  } else {
    await companyRepo.findOneByOrFail({ id: companyId });
  }
  const repo = manager.getRepository(WorkloadLease);
  await repo.delete({ companyId, expiresAt: LessThanOrEqual(new Date()) });
  if ((await repo.count({ where: { employeeId } })) > 0) {
    throw new EmployeeWorkloadBusyError();
  }
  if ((await repo.count({ where: { companyId } })) >= config.agent.maxConcurrentRunsPerCompany) {
    throw new WorkloadLimitError();
  }
  return repo.save(
    repo.create({
      companyId,
      employeeId,
      kind,
      expiresAt: new Date(Date.now() + Math.max(60_000, ttlMs)),
    }),
  );
}

export async function acquireWorkloadLease(
  companyId: string,
  employeeId: string,
  kind: "chat" | "routine",
  ttlMs: number,
): Promise<WorkloadLease> {
  if (config.db.driver === "postgres") {
    return AppDataSource.transaction((manager) =>
      acquireWithManager(manager, companyId, employeeId, kind, ttlMs),
    );
  }
  return sqliteExclusive(() =>
    acquireWithManager(AppDataSource.manager, companyId, employeeId, kind, ttlMs),
  );
}

export async function releaseWorkloadLease(lease: WorkloadLease | null): Promise<void> {
  if (!lease) return;
  await AppDataSource.getRepository(WorkloadLease).delete({ id: lease.id });
}

/**
 * What an employee is currently busy with, so a rejected chat turn can point
 * the teammate at the work in progress by name instead of surfacing a dead
 * error. The lease tells us chat-vs-routine; for a routine we look up the
 * running {@link Run} to name and link it. Best-effort — returns `null` when
 * the employee isn't actually holding a lease any more (the busy window can
 * close between the failed acquire and this read), and `routine: null` when a
 * routine lease exists but its run row can't be pinned down.
 */
export type EmployeeWorkloadInfo =
  | { kind: "chat" }
  | { kind: "routine"; routine: { name: string; slug: string } | null };

export async function describeEmployeeWorkload(
  employeeId: string,
): Promise<EmployeeWorkloadInfo | null> {
  const lease = await AppDataSource.getRepository(WorkloadLease).findOne({
    where: { employeeId },
    order: { createdAt: "DESC" },
  });
  if (!lease) return null;
  if (lease.kind !== "routine") return { kind: "chat" };

  // Run only carries `routineId`, so resolve this employee's routines first,
  // then find the newest still-running Run among them. Two small reads keep
  // this identical on SQLite and Postgres without a hand-rolled join.
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId },
  });
  if (routines.length === 0) return { kind: "routine", routine: null };
  const running = await AppDataSource.getRepository(Run).findOne({
    where: { status: "running", routineId: In(routines.map((r) => r.id)) },
    order: { startedAt: "DESC" },
  });
  const routine = running
    ? routines.find((r) => r.id === running.routineId) ?? null
    : null;
  return {
    kind: "routine",
    routine: routine ? { name: routine.name, slug: routine.slug } : null,
  };
}
