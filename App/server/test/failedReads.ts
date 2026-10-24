import type { TestContext } from "node:test";

import { QueryFailedError } from "typeorm";

import { AppDataSource } from "../db/datasource.js";

/**
 * Fail the next read of `table` during test `t` the way a locked database
 * fails a statement, and leave every other statement alone. `skip` lets that
 * many reads of `table` through first, for when a guard reads the table before
 * the read under test does.
 *
 * TypeORM hands each statement to `AppDataSource.logger.logQuery` just before
 * it runs it, so a throw there fails that read where SQLite would. Middleware
 * that awaits the read without a `catch` leaves its request open, because
 * Express 4 drops a rejected promise. Send the request with
 * `AbortSignal.timeout` so a request left open fails the test instead of
 * stalling the suite.
 */
export function failNextRead(t: TestContext, table: string, { skip = 0 } = {}): void {
  const readsTable = new RegExp(`^\\s*SELECT\\b[\\s\\S]*?\\bFROM "${table}"`, "i");
  let passed = 0;
  let failed = false;
  t.mock.method(AppDataSource.logger, "logQuery", (query: string, parameters?: unknown[]) => {
    if (failed || !readsTable.test(query)) return;
    if (passed < skip) {
      passed += 1;
      return;
    }
    failed = true;
    throw new QueryFailedError(query, parameters, new Error("SQLITE_BUSY: database is locked"));
  });
}
