import type { EntityManager } from "typeorm";
import { AppDataSource } from "./datasource.js";

// SQLite shares one connection, so these independent acceptance writes must not
// overlap BEGIN/COMMIT. Postgres has one connection per transaction already.
let pending: Promise<void> = Promise.resolve();

export function withSerializedTransaction<T>(
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  if (AppDataSource.options.type === "postgres") return AppDataSource.transaction(work);
  const next = pending.then(() => AppDataSource.transaction(work));
  pending = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
