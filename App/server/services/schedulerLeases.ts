import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { config } from "../../config.js";

const INSTANCE_ID = crypto.randomUUID();

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
  const result = await AppDataSource.getRepository(SchedulerLease)
    .createQueryBuilder()
    .update()
    .set({ expiresAt: new Date(Date.now() + ttlMs) })
    .where("name = :name AND holderId = :holderId", { name, holderId })
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
  fn: (lease: { isHeld: () => boolean; holderId: string | null }) => Promise<T>,
): Promise<T | null> {
  // SQLite is single-process here and TypeORM exposes one connection. A
  // transaction used as a distributed lock can collide with unrelated startup
  // work, so the caller's in-process guard is the lease in self-hosted mode.
  if (config.db.driver !== "postgres") return fn({ isHeld: () => true, holderId: null });
  const holderId = `${INSTANCE_ID}:${crypto.randomUUID()}`;
  if (!(await acquire(name, ttlMs, holderId))) return null;
  let held = true;
  let renewalTail = Promise.resolve();
  const renewal = setInterval(
    () => {
      renewalTail = renewalTail.then(async () => {
        if (!held) return;
        try {
          const renewed = await renew(name, ttlMs, holderId);
          if (!renewed) held = false;
        } catch (error) {
          // Conservatively fence the worker. A transient database failure can
          // let the lease expire before the next renewal, so continuing would
          // risk two app instances mutating the same resource.
          held = false;
          // eslint-disable-next-line no-console
          console.error(`[scheduler] failed to renew ${name}:`, error);
        }
      });
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  if (typeof renewal.unref === "function") renewal.unref();
  try {
    return await fn({ isHeld: () => held, holderId });
  } finally {
    clearInterval(renewal);
    // Do not let a renewal that was already in flight land after release and
    // resurrect the lease for another full TTL.
    await renewalTail;
    await release(name, holderId).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[scheduler] failed to release ${name}:`, error);
    });
  }
}
