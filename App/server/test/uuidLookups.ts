import type { EntityTarget, ObjectLiteral } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { UUID_RE } from "../services/bases.js";

/**
 * Every non-uuid `id` that reached `findOneBy` on `entity`'s repository while
 * `run` ran.
 *
 * SQLite cannot reproduce the failure this exists for: Postgres types the
 * primary keys as uuid and raises 22P02 when a query compares one to a slug
 * like "general", so the request fails instead of falling through to the slug
 * lookup, while SQLite just returns no rows. A slug resolving in a test
 * therefore proves nothing on its own; it must also never reach the id lookup,
 * which is what `UUID_RE` guards. bases.test.ts pins its row id guards with the
 * same kind of spy.
 */
export async function withNonUuidIdLookups<T>(
  entity: EntityTarget<ObjectLiteral>,
  run: () => Promise<T>,
): Promise<{ result: T; nonUuidIds: string[] }> {
  const repo = AppDataSource.getRepository(entity);
  const original = repo.findOneBy;
  const nonUuidIds: string[] = [];
  const mutable = repo as unknown as { findOneBy: typeof repo.findOneBy };
  mutable.findOneBy = ((where: Parameters<typeof repo.findOneBy>[0]) => {
    for (const clause of Array.isArray(where) ? where : [where]) {
      const id: unknown = clause.id;
      if (typeof id === "string" && !UUID_RE.test(id)) nonUuidIds.push(id);
    }
    return original.call(repo, where);
  }) as typeof repo.findOneBy;
  try {
    return { result: await run(), nonUuidIds };
  } finally {
    mutable.findOneBy = original;
  }
}
