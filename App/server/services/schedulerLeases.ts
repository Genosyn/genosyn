import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { config } from "../../config.js";

const INSTANCE_ID = crypto.randomUUID();

export class SchedulerLeaseLostError extends Error {
  constructor(name: string) {
    super(`Scheduler lease ${name} is no longer held`);
    this.name = "SchedulerLeaseLostError";
  }
}

export type SchedulerLeaseContext = {
  isHeld: () => boolean;
  assertHeld: () => void;
  signal: AbortSignal;
  holderId: string | null;
};

async function ensureLease(name: string): Promise<void> {
  await AppDataSource.getRepository(SchedulerLease)
    .createQueryBuilder()
    .insert()
    .values({ name, holderId: "", expiresAt: null })
    .orIgnore()
    .execute();
}

async function acquire(name: string, ttlMs: number, holderId: string): Promise<boolean> {
  await ensureLease(name);
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(SchedulerLease);
    const row =
      config.db.driver === "postgres"
        ? await repo.findOneOrFail({
            where: { name },
            lock: { mode: "pessimistic_write" },
          })
        : await repo.findOneByOrFail({ name });
    const now = new Date();
    if (row.expiresAt && row.expiresAt > now && row.holderId !== holderId) {
      return false;
    }
    row.holderId = holderId;
    row.expiresAt = new Date(now.getTime() + ttlMs);
    await repo.save(row);
    return true;
  });
}

async function renew(name: string, ttlMs: number, holderId: string): Promise<boolean> {
  const now = new Date();
  const result = await AppDataSource.getRepository(SchedulerLease)
    .createQueryBuilder()
    .update()
    .set({ expiresAt: new Date(now.getTime() + ttlMs) })
    .where("name = :name AND holderId = :holderId", { name, holderId })
    // A delayed renewal must not resurrect an expired owner, even when no
    // replacement has acquired the row yet.
    .andWhere('"expiresAt" > clock_timestamp()')
    .execute();
  return (result.affected ?? 0) === 1;
}

async function release(name: string, holderId: string): Promise<void> {
  await AppDataSource.getRepository(SchedulerLease)
    .createQueryBuilder()
    .update()
    .set({ expiresAt: new Date(0) })
    .where("name = :name AND holderId = :holderId", { name, holderId })
    .execute();
}

export async function withSchedulerLease<T>(
  name: string,
  ttlMs: number,
  fn: (lease: SchedulerLeaseContext) => Promise<T>,
): Promise<T | null> {
  // SQLite is single-process here and TypeORM exposes one connection. A
  // transaction used as a distributed lock can collide with unrelated startup
  // work, so the caller's in-process guard is the lease in self-hosted mode.
  if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("Scheduler lease TTL must be positive");
  if (config.db.driver !== "postgres") {
    return fn({
      isHeld: () => true,
      assertHeld: () => undefined,
      signal: new AbortController().signal,
      holderId: null,
    });
  }
  const holderId = `${INSTANCE_ID}:${crypto.randomUUID()}`;
  // Start the local deadline before the database round trip. Being early is
  // safe; extending ownership by the response latency is not.
  let expiresAt = Date.now() + ttlMs;
  if (!(await acquire(name, ttlMs, holderId))) return null;
  const controller = new AbortController();
  const loseLease = (): void => {
    if (!controller.signal.aborted) controller.abort(new SchedulerLeaseLostError(name));
  };
  const isHeld = (): boolean => {
    if (Date.now() >= expiresAt) loseLease();
    return !controller.signal.aborted;
  };
  const assertHeld = (): void => {
    if (!isHeld()) throw controller.signal.reason;
  };
  let expiryTimer: NodeJS.Timeout;
  const armExpiry = (): void => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(loseLease, Math.max(0, expiresAt - Date.now()));
    expiryTimer.unref();
  };
  armExpiry();
  let renewalTail = Promise.resolve();
  const renewal = setInterval(
    () => {
      renewalTail = renewalTail.then(async () => {
        if (!isHeld()) return;
        try {
          const renewedUntil = Date.now() + ttlMs;
          const renewed = await renew(name, ttlMs, holderId);
          if (!renewed || !isHeld()) {
            loseLease();
          } else {
            expiresAt = renewedUntil;
            armExpiry();
          }
        } catch (error) {
          // Conservatively fence the worker. A transient database failure can
          // let the lease expire before the next renewal, so continuing would
          // risk two app instances mutating the same resource.
          loseLease();
          // eslint-disable-next-line no-console
          console.error(`[scheduler] failed to renew ${name}:`, error);
        }
      });
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  if (typeof renewal.unref === "function") renewal.unref();
  try {
    assertHeld();
    // Cancellation is cooperative: callers check before each dispatch/write
    // and pass signal to cancellable work. It cannot retract an external
    // request already accepted, so we wait for cleanup instead of racing fn.
    return await fn({ isHeld, assertHeld, signal: controller.signal, holderId });
  } finally {
    clearInterval(renewal);
    clearTimeout(expiryTimer!);
    loseLease();
    // Do not let a renewal that was already in flight land after release and
    // resurrect the lease for another full TTL.
    await renewalTail;
    await release(name, holderId).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[scheduler] failed to release ${name}:`, error);
    });
  }
}
