import crypto from "node:crypto";
import type { Request } from "express";
import { AppDataSource } from "../db/datasource.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { config } from "../../config.js";

export class AuthRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Too many attempts. Try again later.");
    this.name = "AuthRateLimitError";
  }
}

function idFor(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function authThrottleKeys(req: Request, scope: string, identity?: string): string[] {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const keys = [idFor(`${scope}:ip:${ip}`)];
  if (identity) keys.push(idFor(`${scope}:identity:${identity.trim().toLowerCase()}`));
  return keys;
}

async function ensureRow(id: string, now: Date): Promise<void> {
  await AppDataSource.getRepository(AuthRateLimit)
    .createQueryBuilder()
    .insert()
    .values({ id, attempts: 0, windowStartedAt: now, blockedUntil: null })
    .orIgnore()
    .execute();
}

async function mutate(
  id: string,
  fn: (row: AuthRateLimit, now: Date) => void,
): Promise<AuthRateLimit> {
  const now = new Date();
  await ensureRow(id, now);
  if (config.db.driver !== "postgres") {
    const repo = AppDataSource.getRepository(AuthRateLimit);
    const row = await repo.findOneByOrFail({ id });
    fn(row, now);
    return repo.save(row);
  }
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(AuthRateLimit);
    const row = await repo.findOneOrFail({
      where: { id },
      lock: { mode: "pessimistic_write" },
    });
    fn(row, now);
    return repo.save(row);
  });
}

function resetExpiredWindow(row: AuthRateLimit, now: Date): void {
  const windowMs = config.security.authRateLimit.windowMinutes * 60_000;
  if (now.getTime() - row.windowStartedAt.getTime() >= windowMs) {
    row.windowStartedAt = now;
    row.attempts = 0;
    row.blockedUntil = null;
  }
  if (row.blockedUntil && row.blockedUntil <= now) {
    row.windowStartedAt = now;
    row.attempts = 0;
    row.blockedUntil = null;
  }
}

const sqliteBucketTails = new Map<string, Promise<void>>();

/** Serialize one SQLite bucket without making unrelated identities wait. */
async function withSqliteBucketLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = sqliteBucketTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  sqliteBucketTails.set(id, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sqliteBucketTails.get(id) === tail) sqliteBucketTails.delete(id);
  }
}

function consumeRow(row: AuthRateLimit, now: Date): void {
  resetExpiredWindow(row, now);
  if (row.blockedUntil && row.blockedUntil > now) {
    throw new AuthRateLimitError(
      Math.max(1, Math.ceil((row.blockedUntil.getTime() - now.getTime()) / 1000)),
    );
  }
  row.attempts += 1;
  if (row.attempts >= config.security.authRateLimit.maxAttempts) {
    row.blockedUntil = new Date(
      now.getTime() + config.security.authRateLimit.blockMinutes * 60_000,
    );
  }
}

/** Atomically admit and count one attempt against one persistent bucket. */
async function consumeBucket(id: string): Promise<void> {
  await ensureRow(id, new Date());
  if (config.db.driver === "postgres") {
    await AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AuthRateLimit);
      const row = await repo.findOneOrFail({
        where: { id },
        lock: { mode: "pessimistic_write" },
      });
      consumeRow(row, new Date());
      await repo.save(row);
    });
    return;
  }

  await withSqliteBucketLock(id, async () => {
    const repo = AppDataSource.getRepository(AuthRateLimit);
    const row = await repo.findOneByOrFail({ id });
    consumeRow(row, new Date());
    await repo.save(row);
  });
}

export async function assertAuthAllowed(keys: string[]): Promise<void> {
  const now = new Date();
  for (const id of keys) {
    await ensureRow(id, now);
    const row = await AppDataSource.getRepository(AuthRateLimit).findOneByOrFail({ id });
    if (row.blockedUntil && row.blockedUntil > now) {
      throw new AuthRateLimitError(
        Math.max(1, Math.ceil((row.blockedUntil.getTime() - now.getTime()) / 1000)),
      );
    }
  }
}

export async function recordAuthFailure(keys: string[]): Promise<void> {
  for (const id of keys) {
    await mutate(id, (row, now) => {
      resetExpiredWindow(row, now);
      row.attempts += 1;
      if (row.attempts >= config.security.authRateLimit.maxAttempts) {
        row.blockedUntil = new Date(
          now.getTime() + config.security.authRateLimit.blockMinutes * 60_000,
        );
      }
    });
  }
}

export async function clearAuthFailures(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await AppDataSource.getRepository(AuthRateLimit).delete(keys);
}

/** Count every request for endpoints that intentionally hide account existence. */
export async function consumeAuthAttempt(keys: string[]): Promise<void> {
  for (const id of keys) await consumeBucket(id);
}
