import { EntityManager, IsNull, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { config } from "../../config.js";

/**
 * Scope for a turn with no transcript of its own — a Base or meeting kickoff.
 *
 * A real string rather than NULL, because NULL already means something else on
 * this table: a lease written by a build from before threads were scoped, when
 * every chat reply for an employee shared one. Keeping the two apart is what
 * lets {@link acquireChatWorkloadLease} stay safe across a rolling upgrade —
 * see the conflict predicate there.
 */
export const EMPLOYEE_WIDE_SCOPE = "employee";

export class EmployeeWorkloadBusyError extends Error {
  readonly status = 409;

  constructor() {
    super("This AI Employee is already replying in this thread. Try again shortly.");
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
  scopeKey: string,
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
  // Postgres replicas. It is only a same-thread reply mutex: another
  // conversation with the same employee, another employee's reply, and every
  // other kind of AI work take their own leases and run in parallel.
  //
  // A NULL scope is also a conflict, and only ever means one thing: a lease a
  // pre-scoping build wrote, when one employee answered one chat at a time.
  // That build cannot see our scope, so during a rolling upgrade it is the
  // side that would let two turns race in one conversation. Treating its rows
  // as employee-wide holds the old guarantee until they drain — the older
  // build blocks on ours symmetrically, since it filters on employee alone.
  const conflicts = await repo.count({
    where: [
      { employeeId, kind: "chat", scopeKey },
      { employeeId, kind: "chat", scopeKey: IsNull() },
    ],
  });
  if (conflicts > 0) {
    throw new EmployeeWorkloadBusyError();
  }
  return repo.save(
    repo.create({
      companyId,
      employeeId,
      kind: "chat",
      scopeKey,
      ownerKey: ownerKey ?? null,
      expiresAt: new Date(Date.now() + Math.max(60_000, ttlMs)),
    }),
  );
}

/**
 * Take the reply lease for one thread of one AI Employee.
 *
 * `scopeKey` names the thread — a conversation, an email thread, a TLDR
 * question. Turns on different threads never contend, which is what lets a
 * Member hold several conversations with the same employee at once. A surface
 * with no thread of its own passes {@link EMPLOYEE_WIDE_SCOPE} and those share
 * a single lease, exactly as they did before threads were scoped.
 */
export async function acquireChatWorkloadLease(
  companyId: string,
  employeeId: string,
  scopeKey: string,
  ttlMs: number,
  options?: { ownerKey?: string },
): Promise<WorkloadLease> {
  if (config.db.driver === "postgres") {
    return AppDataSource.transaction((manager) =>
      acquireWithManager(manager, companyId, employeeId, scopeKey, ttlMs, options?.ownerKey),
    );
  }
  return sqliteExclusive(() =>
    acquireWithManager(
      AppDataSource.manager,
      companyId,
      employeeId,
      scopeKey,
      ttlMs,
      options?.ownerKey,
    ),
  );
}

export async function releaseChatWorkloadLease(lease: WorkloadLease | null): Promise<void> {
  if (!lease) return;
  await AppDataSource.getRepository(WorkloadLease).delete({ id: lease.id });
}

/**
 * Drop a durable turn's reply lease by the stable key that turn owns.
 *
 * For when a turn is terminalized from outside the process that acquired the
 * lease. `acquireWithManager` purges by `ownerKey` too, but only when someone
 * re-acquires under the same key — and a turn that will never run again never
 * does, so its lease would sit there reading as busy until the six-hour TTL
 * ran out. Deleting by key rather than by id is the point: the caller is
 * precisely the one that does not hold the row.
 */
export async function releaseChatWorkloadLeaseByOwner(ownerKey: string): Promise<void> {
  await AppDataSource.getRepository(WorkloadLease).delete({ ownerKey });
}
