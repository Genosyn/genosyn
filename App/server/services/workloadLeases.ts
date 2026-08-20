import { EntityManager, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { config } from "../../config.js";

export class EmployeeWorkloadBusyError extends Error {
  readonly status = 409;

  constructor() {
    super("This AI Employee is already replying to another chat. Try again shortly.");
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
  ttlMs: number,
  ownerKey?: string,
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
  if (ownerKey) {
    // A durable turn keeps one stable key across process lifetimes. Its
    // message-level worker claim is the authority on who may execute, so a
    // successful recovery claim can discard the reply lease left behind by
    // the interrupted process instead of reading as busy for six hours.
    await repo.delete({ ownerKey });
  }

  // The company row lock above makes this check-and-insert atomic across
  // Postgres replicas. It is only a same-employee reply mutex: other AI work,
  // including other employees' replies, never consumes a limited pool.
  if ((await repo.count({ where: { employeeId, kind: "chat" } })) > 0) {
    throw new EmployeeWorkloadBusyError();
  }
  return repo.save(
    repo.create({
      companyId,
      employeeId,
      kind: "chat",
      ownerKey: ownerKey ?? null,
      expiresAt: new Date(Date.now() + Math.max(60_000, ttlMs)),
    }),
  );
}

export async function acquireChatWorkloadLease(
  companyId: string,
  employeeId: string,
  ttlMs: number,
  options?: { ownerKey?: string },
): Promise<WorkloadLease> {
  if (config.db.driver === "postgres") {
    return AppDataSource.transaction((manager) =>
      acquireWithManager(manager, companyId, employeeId, ttlMs, options?.ownerKey),
    );
  }
  return sqliteExclusive(() =>
    acquireWithManager(AppDataSource.manager, companyId, employeeId, ttlMs, options?.ownerKey),
  );
}

export async function releaseChatWorkloadLease(lease: WorkloadLease | null): Promise<void> {
  if (!lease) return;
  await AppDataSource.getRepository(WorkloadLease).delete({ id: lease.id });
}
