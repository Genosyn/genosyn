import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  AppDataSource,
  MIGRATION_LOCK_CLASS_ID,
  MIGRATION_LOCK_OBJECT_ID,
  MIGRATION_LOCK_TIMEOUT_MS,
  runMigrationsExclusively,
} from "./datasource.js";

/**
 * Boot migrations are mutually exclusive across replicas.
 *
 * `runMigrations()` reads the `migrations` table, decides what is missing, and
 * applies it, with no lock between the read and the write. One pod is fine.
 * Several starting together — a RollingUpdate, a scaled Deployment, a cluster
 * restart — each read "nothing applied" and race the same DDL; the losers
 * crash on `relation already exists`, and `failureThreshold: 6` on the
 * liveness probe turns that into a slow partial rollout rather than an obvious
 * failure.
 *
 * There is no Postgres in this suite, so the driver is stubbed and the
 * assertions are about the *sequence*: what is issued, in what order, and that
 * the lock is released on both the happy and the failing path. Those are the
 * properties a real server would not check any better.
 */

type Issued = { sql: string; params?: unknown[] };

let issued: Issued[];
let released: number;
let migrationsRun: number;
let originalType: string;
const originalCreateQueryRunner = AppDataSource.createQueryRunner.bind(AppDataSource);
const originalRunMigrations = AppDataSource.runMigrations.bind(AppDataSource);

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  issued = [];
  released = 0;
  migrationsRun = 0;
  originalType = AppDataSource.options.type;
});

afterEach(() => {
  (AppDataSource.options as { type: string }).type = originalType;
  AppDataSource.createQueryRunner = originalCreateQueryRunner;
  AppDataSource.runMigrations = originalRunMigrations;
});

/** Pretend to be Postgres, recording every statement the lock path issues. */
function stubPostgres(options: { failMigration?: boolean; failUnlock?: boolean } = {}) {
  (AppDataSource.options as { type: string }).type = "postgres";
  AppDataSource.createQueryRunner = (() => ({
    connect: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      issued.push({ sql, params });
      if (options.failUnlock && sql.includes("pg_advisory_unlock")) {
        throw new Error("unlock exploded");
      }
      return [];
    },
    release: async () => {
      released += 1;
    },
  })) as never;
  AppDataSource.runMigrations = (async () => {
    migrationsRun += 1;
    if (options.failMigration) throw new Error("migration exploded");
    return [];
  }) as never;
}

describe("lock identity", () => {
  test('classid spells "GENO" so a pg_locks row is recognisable', () => {
    assert.equal(MIGRATION_LOCK_CLASS_ID, 0x47454e4f);
    assert.equal(
      Buffer.from(MIGRATION_LOCK_CLASS_ID.toString(16), "hex").toString("ascii"),
      "GENO",
    );
  });

  test("the keys are stable constants", () => {
    // A rolling upgrade runs two builds at once. If a release changed either
    // key, the old and new pods would take *different* locks and neither would
    // exclude the other — which is the exact failure this lock exists to
    // prevent, reintroduced silently. Changing these is a breaking change.
    assert.equal(MIGRATION_LOCK_CLASS_ID, 1195724367);
    assert.equal(MIGRATION_LOCK_OBJECT_ID, 1);
  });

  test("both keys fit in the int4 pair pg_advisory_lock takes", () => {
    for (const key of [MIGRATION_LOCK_CLASS_ID, MIGRATION_LOCK_OBJECT_ID]) {
      assert.ok(Number.isInteger(key));
      assert.ok(key >= -(2 ** 31) && key <= 2 ** 31 - 1, `${key} out of int4 range`);
    }
  });

  test("the wait is generous but bounded", () => {
    // Long enough that a real migration on a large table is not killed
    // halfway; short enough that a lock orphaned by a dead backend eventually
    // fails the boot loudly instead of hanging behind a probe that never fires.
    assert.ok(MIGRATION_LOCK_TIMEOUT_MS >= 60_000);
    assert.ok(MIGRATION_LOCK_TIMEOUT_MS <= 30 * 60_000);
  });
});

describe("postgres path", () => {
  test("takes the lock, migrates, then releases", async () => {
    stubPostgres();
    await runMigrationsExclusively();
    const sql = issued.map((i) => i.sql);
    assert.match(sql[0], /SET lock_timeout/);
    assert.match(sql[1], /pg_advisory_lock/);
    assert.match(sql[2], /pg_advisory_unlock/);
    assert.equal(migrationsRun, 1);
    assert.equal(released, 1);
  });

  test("the lock is taken before migrations run, not after", async () => {
    const order: string[] = [];
    (AppDataSource.options as { type: string }).type = "postgres";
    AppDataSource.createQueryRunner = (() => ({
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.includes("pg_advisory_lock")) order.push("lock");
        if (sql.includes("pg_advisory_unlock")) order.push("unlock");
        return [];
      },
      release: async () => order.push("release"),
    })) as never;
    AppDataSource.runMigrations = (async () => {
      order.push("migrate");
      return [];
    }) as never;

    await runMigrationsExclusively();
    assert.deepEqual(order, ["lock", "migrate", "unlock", "release"]);
  });

  test("passes both key halves as parameters, never interpolated", async () => {
    stubPostgres();
    await runMigrationsExclusively();
    const lock = issued.find((i) => i.sql.includes("pg_advisory_lock"));
    assert.deepEqual(lock?.params, [MIGRATION_LOCK_CLASS_ID, MIGRATION_LOCK_OBJECT_ID]);
    assert.match(String(lock?.sql), /\$1, \$2/);
  });

  test("unlocks with the same keys it locked with", async () => {
    stubPostgres();
    await runMigrationsExclusively();
    const lock = issued.find((i) => i.sql.includes("pg_advisory_lock"));
    const unlock = issued.find((i) => i.sql.includes("pg_advisory_unlock"));
    assert.deepEqual(unlock?.params, lock?.params);
  });

  test("sets the wait bound before attempting to acquire", async () => {
    stubPostgres();
    await runMigrationsExclusively();
    const timeoutIndex = issued.findIndex((i) => i.sql.includes("lock_timeout"));
    const lockIndex = issued.findIndex((i) => i.sql.includes("pg_advisory_lock"));
    assert.ok(timeoutIndex >= 0 && timeoutIndex < lockIndex);
    assert.match(issued[timeoutIndex].sql, new RegExp(String(MIGRATION_LOCK_TIMEOUT_MS)));
  });

  test("a failing migration still releases the lock and the connection", async () => {
    stubPostgres({ failMigration: true });
    await assert.rejects(() => runMigrationsExclusively(), /migration exploded/);
    assert.ok(
      issued.some((i) => i.sql.includes("pg_advisory_unlock")),
      "the lock must not be leaked when a migration throws",
    );
    assert.equal(released, 1);
  });

  test("a failing unlock does not mask the migration error", async () => {
    stubPostgres({ failMigration: true, failUnlock: true });
    await assert.rejects(() => runMigrationsExclusively(), /migration exploded/);
    assert.equal(released, 1, "the connection is released even when unlock throws");
  });

  test("a failing unlock on the happy path does not fail the boot", async () => {
    stubPostgres({ failUnlock: true });
    // Releasing the session drops the lock anyway, so this must not be fatal.
    await assert.doesNotReject(() => runMigrationsExclusively());
    assert.equal(released, 1);
  });
});

describe("sqlite path", () => {
  test("migrates directly, with no advisory lock", async () => {
    let ran = 0;
    AppDataSource.runMigrations = (async () => {
      ran += 1;
      return [];
    }) as never;
    AppDataSource.createQueryRunner = (() => {
      throw new Error("sqlite must not open a query runner for locking");
    }) as never;

    await runMigrationsExclusively();
    assert.equal(ran, 1);
  });

  test("the real in-memory database runs it without incident", async () => {
    // No stubs at all: the harness's own DataSource, which is what every
    // other test file boots against.
    await assert.doesNotReject(() => runMigrationsExclusively());
  });
});
