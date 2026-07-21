import { EntityManager, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
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
