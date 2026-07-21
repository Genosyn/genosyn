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

async function acquire(name: string, ttlMs: number): Promise<boolean> {
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
    if (row.expiresAt && row.expiresAt > now && row.holderId !== INSTANCE_ID) {
      return false;
    }
    row.holderId = INSTANCE_ID;
    row.expiresAt = new Date(now.getTime() + ttlMs);
    await repo.save(row);
    return true;
  });
}

async function renew(name: string, ttlMs: number): Promise<boolean> {
  const result = await AppDataSource.getRepository(SchedulerLease)
    .createQueryBuilder()
    .update()
    .set({ expiresAt: new Date(Date.now() + ttlMs) })
    .where("name = :name AND holderId = :holderId", { name, holderId: INSTANCE_ID })
    .execute();
  return (result.affected ?? 0) === 1;
}

async function release(name: string): Promise<void> {
  await AppDataSource.getRepository(SchedulerLease)
    .createQueryBuilder()
    .update()
    .set({ expiresAt: new Date(0) })
    .where("name = :name AND holderId = :holderId", { name, holderId: INSTANCE_ID })
    .execute();
}

export async function withSchedulerLease<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  // SQLite is single-process here and TypeORM exposes one connection. A
  // transaction used as a distributed lock can collide with unrelated startup
  // work, so the caller's in-process guard is the lease in self-hosted mode.
  if (config.db.driver !== "postgres") return fn();
  if (!(await acquire(name, ttlMs))) return null;
  const renewal = setInterval(
    () => {
      void renew(name, ttlMs).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] failed to renew ${name}:`, error);
      });
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  if (typeof renewal.unref === "function") renewal.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renewal);
    await release(name).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[scheduler] failed to release ${name}:`, error);
    });
  }
}
