import { MigrationExecutor } from "typeorm";
import type { Migration, QueryRunner } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { config } from "../../config.js";
import type { InstanceSeverity } from "./instanceHealth.js";

/**
 * Admin → Migrations — the detailed, per-migration view of the schema history.
 *
 * This exists separately from `services/instanceHealth.ts` on purpose. That
 * file's `checkMigrations()` answers one boolean — "is anything pending?" — as
 * a single row in an install-wide health roll-up. It deliberately stays cheap
 * and shallow. This service answers the follow-up question an operator asks the
 * moment that check goes yellow: *which* migrations, in what order, and is the
 * database ahead of or behind the code? Keeping the two apart lets the health
 * probe stay a one-line summary while this pays for a full table read.
 *
 * ── The constraint every future reader trips over ────────────────────────────
 * THERE IS NO WALL-CLOCK "APPLIED AT" COLUMN. TypeORM's `migrations` table has
 * exactly three columns:
 *
 *   id         auto-increment — the order migrations were EXECUTED in
 *   timestamp  the migration's own AUTHORED timestamp, parsed from its class
 *              name (`Init1776188492090` → 1776188492090)
 *   name       the class name
 *
 * `timestamp` is when the migration was WRITTEN, not when it ran. Nothing
 * records when it ran. So we surface it as `authoredAt` and never as
 * "Applied at" / "Ran at" — labelling an authored timestamp as a run time would
 * tell an operator a deploy happened months before it did, which is exactly the
 * kind of lie a debugging session is destroyed by. For "when did this run,
 * relative to the others?" use `batchId` (the id), which gives ORDER but not
 * time. If you want a real applied-at, it takes a migration adding a column and
 * a TypeORM override — do not fake one from `timestamp`.
 *
 * ── Read-only ────────────────────────────────────────────────────────────────
 * Strictly. No run / revert / fake. Boot already applies migrations via
 * `initDb()`'s `runMigrations()`; a browser-triggered schema mutation behind a
 * GET is not something this app should own. Note the `hasTable` probe below —
 * TypeORM's `getExecutedMigrations()` would CREATE the bookkeeping table as a
 * side effect, which we must not do from a read path.
 */

/**
 * applied — defined in code AND recorded in the database.
 * pending — defined in code, ABSENT from the database. Boot applies migrations,
 *           so in practice this means a boot-time migration failed.
 * unknown — recorded in the database, ABSENT from the code. Schema drift: the
 *           database is ahead of the build (e.g. the app was rolled back
 *           without reverting the schema).
 */
export type MigrationState = "applied" | "pending" | "unknown";

export type MigrationEntry = {
  /** TypeORM migration class name, e.g. "Init1776188492090". */
  name: string;
  /** Human title with the timestamp suffix stripped, e.g. "Init". */
  title: string;
  /** Authored timestamp (ms epoch) parsed from the class-name suffix. */
  timestamp: number;
  /** ISO of `timestamp` — when the migration was WRITTEN, not when it ran. */
  authoredAt: string;
  state: MigrationState;
  /** migrations.id — the execution order rank. null when pending. */
  batchId: number | null;
};

export type MigrationIssue = {
  /** Stable key: "pending" | "unknown" | "out_of_order". */
  id: string;
  severity: InstanceSeverity;
  title: string;
  detail: string;
  /** Migration class names implicated by this issue. */
  migrations: string[];
};

export type MigrationReport = {
  generatedAt: string;
  driver: "sqlite" | "postgres";
  status: InstanceSeverity;
  summary: string;
  total: number;
  appliedCount: number;
  pendingCount: number;
  unknownCount: number;
  lastApplied: {
    name: string;
    title: string;
    authoredAt: string;
    batchId: number | null;
  } | null;
  issues: MigrationIssue[];
  /** Every migration, sorted by `timestamp` DESC (newest first). */
  migrations: MigrationEntry[];
};

const SEVERITY_RANK: Record<InstanceSeverity, number> = {
  ok: 0,
  warn: 1,
  error: 2,
};

function worstSeverity(severities: InstanceSeverity[]): InstanceSeverity {
  return severities.reduce<InstanceSeverity>(
    (acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc),
    "ok",
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "Init1776188492090" → "Init". The suffix is the authored timestamp. */
function titleFromName(name: string): string {
  return name.replace(/\d+$/, "");
}

/**
 * The authored timestamp comes off a class name for code migrations, but off a
 * database column for drift rows — which nothing validates. A garbage value
 * would make `new Date(...).toISOString()` throw a RangeError and take the
 * whole report down, so an unusable timestamp degrades to the epoch. It renders
 * as 1970, which reads as "broken" to an operator rather than as a plausible
 * date. That is the intent.
 */
function authoredAtFrom(timestamp: number): string {
  const at = new Date(timestamp);
  return Number.isFinite(at.getTime()) ? at.toISOString() : new Date(0).toISOString();
}

function entryFrom(
  migration: Migration,
  state: MigrationState,
  batchId: number | null,
): MigrationEntry {
  return {
    name: migration.name,
    title: titleFromName(migration.name),
    timestamp: migration.timestamp,
    authoredAt: authoredAtFrom(migration.timestamp),
    state,
    batchId,
  };
}

/**
 * The report we return when the migrations table can't be read at all — the
 * database is down, or the table doesn't exist yet. `status` is set directly
 * rather than derived from `issues`: none of the three stable issue ids
 * ("pending" | "unknown" | "out_of_order") describe "we couldn't look", and
 * inventing a fourth would break the contract the client renders against. The
 * explanation rides on `summary`.
 *
 * `total` still reports the code-defined count — that comes from the build, not
 * the database, so it's knowable even when nothing else is. Every state count
 * is 0 and `migrations` is empty because we genuinely do not know the state of
 * any single migration; guessing one here would be the same lie as a fake
 * applied-at.
 */
function unreadableReport(reason: string): MigrationReport {
  return {
    generatedAt: new Date().toISOString(),
    driver: config.db.driver,
    status: "error",
    summary: `Could not read the migrations table: ${reason}`,
    total: AppDataSource.migrations.length,
    appliedCount: 0,
    pendingCount: 0,
    unknownCount: 0,
    lastApplied: null,
    issues: [],
    migrations: [],
  };
}

/**
 * Reconcile the code-defined migrations against the rows in the database and
 * derive the health issues. Pure — takes both snapshots, touches nothing.
 *
 * @param all       code-defined migrations (timestamp ASC)
 * @param executed  rows from the migrations table (id DESC)
 */
function buildReport(all: Migration[], executed: Migration[]): MigrationReport {
  const executedByName = new Map<string, Migration>(
    executed.map((m) => [m.name, m]),
  );
  const codeNames = new Set(all.map((m) => m.name));

  const migrations: MigrationEntry[] = [];

  // Everything the build knows about: applied if the database has it too.
  for (const migration of all) {
    const row = executedByName.get(migration.name);
    migrations.push(
      row
        ? entryFrom(migration, "applied", row.id ?? null)
        : entryFrom(migration, "pending", null),
    );
  }

  // Drift: rows the database has that this build does not. TypeORM has no
  // helper for these — `getPendingMigrations()` only looks the other way — so
  // we match by name ourselves. Timestamp and id come off the row.
  for (const row of executed) {
    if (codeNames.has(row.name)) continue;
    migrations.push(entryFrom(row, "unknown", row.id ?? null));
  }

  migrations.sort((a, b) => b.timestamp - a.timestamp);

  const applied = migrations.filter((m) => m.state === "applied");
  const pending = migrations.filter((m) => m.state === "pending");
  const unknown = migrations.filter((m) => m.state === "unknown");

  const issues: MigrationIssue[] = [];

  if (pending.length > 0) {
    issues.push({
      id: "pending",
      severity: "warn",
      title: `${pending.length} ${plural(pending.length, "migration is", "migrations are")} pending`,
      detail:
        "Boot applies migrations automatically, so a pending migration usually means one FAILED during start-up rather than that it was never attempted. The schema is behind the code until it lands — check the server logs from the last restart for the error.",
      migrations: pending.map((m) => m.name),
    });
  }

  if (unknown.length > 0) {
    issues.push({
      id: "unknown",
      severity: "warn",
      title: `${unknown.length} unknown ${plural(unknown.length, "migration", "migrations")} in the database`,
      detail:
        "The database is ahead of the code: these migrations are recorded in the migrations table but have no matching class in this build. That usually means the app was rolled back without reverting the schema. Their changes are still live in the database, and this build cannot revert them.",
      migrations: unknown.map((m) => m.name),
    });
  }

  // Merge-order hazard: a pending migration authored BEFORE the newest applied
  // one. It was written against an older schema but will run after newer
  // migrations already have — the classic "two branches merged out of order"
  // failure. Ordering is by authored timestamp, which is the only ordering the
  // pending side has (a pending migration has no id yet).
  const newestApplied = applied.reduce<MigrationEntry | null>(
    (acc, m) => (acc === null || m.timestamp > acc.timestamp ? m : acc),
    null,
  );
  const outOfOrder = newestApplied
    ? pending.filter((m) => m.timestamp < newestApplied.timestamp)
    : [];
  if (newestApplied && outOfOrder.length > 0) {
    issues.push({
      id: "out_of_order",
      severity: "warn",
      title: `${outOfOrder.length} pending ${plural(outOfOrder.length, "migration was", "migrations were")} authored out of order`,
      detail: `These are older than the newest applied migration (${newestApplied.title}, authored ${newestApplied.authoredAt}), so they will apply AFTER migrations that are already in the database. If they assume the schema as it stood when they were written, they can fail or silently do the wrong thing. Review them before the next restart.`,
      migrations: outOfOrder.map((m) => m.name),
    });
  }

  // What actually ran last, by execution order (id) rather than authored
  // timestamp — the two disagree exactly when migrations land out of order,
  // and "last applied" means the last one the database ran. Drift rows count:
  // they are in the migrations table, so one of them really can be the most
  // recent thing applied, and hiding that would bury the drift.
  const lastAppliedEntry = migrations.reduce<MigrationEntry | null>(
    (acc, m) =>
      m.batchId !== null && (acc === null || m.batchId > (acc.batchId ?? -1))
        ? m
        : acc,
    null,
  );

  const total = migrations.length;
  const status = worstSeverity(issues.map((i) => i.severity));

  return {
    generatedAt: new Date().toISOString(),
    driver: config.db.driver,
    status,
    summary: buildSummary(total, applied.length, pending.length, unknown.length),
    total,
    appliedCount: applied.length,
    pendingCount: pending.length,
    unknownCount: unknown.length,
    lastApplied: lastAppliedEntry
      ? {
          name: lastAppliedEntry.name,
          title: lastAppliedEntry.title,
          authoredAt: lastAppliedEntry.authoredAt,
          batchId: lastAppliedEntry.batchId,
        }
      : null,
    issues,
    migrations,
  };
}

function buildSummary(
  total: number,
  appliedCount: number,
  pendingCount: number,
  unknownCount: number,
): string {
  if (total === 0) return "No migrations are defined in this build.";
  if (pendingCount === 0 && unknownCount === 0) {
    return `All ${total} ${plural(total, "migration is", "migrations are")} applied — the schema matches the code.`;
  }
  const parts: string[] = [];
  if (pendingCount > 0) parts.push(`${pendingCount} pending`);
  if (unknownCount > 0) parts.push(`${unknownCount} unknown`);
  return `${appliedCount} of ${total} ${plural(total, "migration", "migrations")} applied — ${parts.join(", ")}.`;
}

/**
 * The full migration report powering Admin → Migrations.
 *
 * Never throws: a database that won't answer is a reportable state, not a 500 —
 * the operator opening this page is usually already debugging something, and a
 * blank error page would tell them less than "the migrations table is missing".
 */
export async function getMigrationReport(): Promise<MigrationReport> {
  if (!AppDataSource.isInitialized) {
    return unreadableReport("the database connection is not initialized.");
  }

  let queryRunner: QueryRunner | null = null;
  try {
    queryRunner = AppDataSource.createQueryRunner();
    const executor = new MigrationExecutor(AppDataSource, queryRunner);

    // `getExecutedMigrations()` calls `createMigrationsTableIfNotExist()`,
    // which CREATEs the table when it's absent. This service must not write, so
    // probe first: if the table isn't there, say so instead of conjuring it.
    // When it does exist that creation step is a verified no-op, so the call
    // below is a pure read.
    const tableName = AppDataSource.options.migrationsTableName || "migrations";
    const migrationsTable = AppDataSource.driver.buildTableName(
      tableName,
      AppDataSource.driver.schema,
      AppDataSource.driver.database,
    );
    if (!(await queryRunner.hasTable(migrationsTable))) {
      return unreadableReport(
        `the \`${migrationsTable}\` table does not exist. It is created the first time migrations run — this database has never been migrated.`,
      );
    }

    // Sequential, not Promise.all: both share this one query runner, which is a
    // single connection. They also form one snapshot — reconciling reads taken
    // at different moments could invent drift that never existed.
    const all = await executor.getAllMigrations();
    const executed = await executor.getExecutedMigrations();
    return buildReport(all, executed);
  } catch (err) {
    return unreadableReport(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (queryRunner) {
      try {
        await queryRunner.release();
      } catch {
        // Best-effort: a runner we failed to release must not mask the report
        // (or the error) we're already returning.
      }
    }
  }
}
