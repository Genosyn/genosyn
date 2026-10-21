import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { AppDataSource } from "./datasource.js";
import { SchedulerLease } from "./entities/SchedulerLease.js";
import { setTransactionWaitLimitForTests } from "./sqliteTransactionGate.js";

/**
 * Regression coverage for the shared SQLite query runner.
 *
 * TypeORM gives every request one runner over better-sqlite3's one connection
 * and counts transaction depth in a field read and written across awaits. A
 * transaction that started while another was committing left that count out
 * of step with SQLite, and from then on nothing was committed: an install lost
 * fifteen hours of work, an invoice among it, when it next restarted. These
 * tests hold the shared connection to that, and to transactions taking turns.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const leases = () => AppDataSource.getRepository(SchedulerLease);
const lease = (name: string) => ({ name, holderId: "test", expiresAt: null });

async function names(): Promise<string[]> {
  return (await leases().find()).map((row) => row.name).sort();
}

/** SQLite's own answer: is the shared connection still inside a transaction? */
function connectionInTransaction(): boolean {
  return (AppDataSource.driver as unknown as { databaseConnection: { inTransaction: boolean } })
    .databaseConnection.inTransaction;
}

/** A transaction that stays open until `finish` is called; `finish(true)` rolls it back. */
function holdTransaction(name: string) {
  let finish!: (rollBack?: boolean) => void;
  const decided = new Promise<boolean>((resolve) => {
    finish = (rollBack = false) => resolve(rollBack);
  });
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const done = AppDataSource.transaction(async (manager) => {
    await manager.getRepository(SchedulerLease).insert(lease(name));
    opened();
    if (await decided) throw new Error("rolled back on purpose");
  });
  return { open, finish, done };
}

/** Whether `promise` settles within a few turns of the event loop. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 20 && !settled; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return settled;
}

describe("SQLite transactions take turns on the shared connection", () => {
  test("keeps committing when a transaction starts while another commits", async () => {
    // Start the second transaction at every offset into the first one's
    // commit: the narrow window where TypeORM's count and SQLite parted ways.
    for (let offset = 0; offset <= 8; offset++) {
      let armed = true;
      let second: Promise<unknown> = Promise.resolve();
      const hook = {
        beforeTransactionCommit() {
          if (!armed) return;
          armed = false;
          second = (async () => {
            for (let tick = 0; tick < offset; tick++) await Promise.resolve();
            await AppDataSource.transaction((manager) =>
              manager.getRepository(SchedulerLease).insert(lease(`second-${offset}`)),
            );
          })();
        },
      };
      AppDataSource.subscribers.push(hook);
      try {
        await AppDataSource.transaction((manager) =>
          manager.getRepository(SchedulerLease).insert(lease(`first-${offset}`)),
        );
        await second;
      } finally {
        AppDataSource.subscribers.splice(AppDataSource.subscribers.indexOf(hook), 1);
      }

      await leases().save(lease(`after-${offset}`));
      assert.equal(
        connectionInTransaction(),
        false,
        `offset ${offset}: SQLite was left inside a transaction nothing would commit`,
      );
    }
    assert.equal((await names()).length, 27);
  });

  test("a save from another request waits for an open transaction instead of joining it", async () => {
    const held = holdTransaction("held");
    await held.open;

    const save = leases().save(lease("invoice"));
    assert.equal(await settlesSoon(save), false, "the save ran inside someone else's transaction");

    // Rolling the open transaction back must not take the other save with it.
    held.finish(true);
    await assert.rejects(held.done, /rolled back on purpose/);
    await save;

    assert.deepEqual(await names(), ["invoice"]);
    assert.equal(connectionInTransaction(), false);
  });

  test("a write outside any transaction waits its turn, then commits", async () => {
    await leases().insert(lease("existing"));
    const held = holdTransaction("held");
    await held.open;

    const update = leases().update({ name: "existing" }, { holderId: "updated" });
    assert.equal(await settlesSoon(update), false, "the update ran inside someone else's transaction");

    held.finish(true);
    await assert.rejects(held.done);
    await update;

    const row = await leases().findOneByOrFail({ name: "existing" });
    assert.equal(row.holderId, "updated");
    assert.equal(connectionInTransaction(), false);
  });

  test("reads never wait", async () => {
    const held = holdTransaction("held");
    await held.open;

    assert.equal(await settlesSoon(leases().count()), true, "a read waited for a transaction");

    held.finish();
    await held.done;
  });

  test("work inside a transaction goes straight through and shares its fate", async () => {
    await assert.rejects(
      AppDataSource.transaction(async (manager) => {
        await manager.getRepository(SchedulerLease).insert(lease("outer"));
        // The global repository and a nested transaction, from inside the
        // callback: both belong to this transaction and must not wait for it.
        await leases().save(lease("global"));
        await AppDataSource.transaction((nested) =>
          nested.getRepository(SchedulerLease).insert(lease("nested")),
        );
        assert.deepEqual(await names(), ["global", "nested", "outer"]);
        throw new Error("roll it all back");
      }),
      /roll it all back/,
    );

    assert.deepEqual(await names(), []);
    assert.equal(connectionInTransaction(), false);
  });

  test("nested transactions started together inside one stay consistent", async () => {
    await AppDataSource.transaction(async () => {
      await Promise.all(
        ["a", "b", "c", "d"].map((name) =>
          AppDataSource.transaction((nested) => nested.getRepository(SchedulerLease).insert(lease(name))),
        ),
      );
    });

    assert.deepEqual(await names(), ["a", "b", "c", "d"]);
    assert.equal(connectionInTransaction(), false);
  });

  test("transactions from separate requests all commit, one at a time", async () => {
    const all = Array.from({ length: 12 }, (_, index) =>
      AppDataSource.transaction(async (manager) => {
        await Promise.resolve();
        await manager.getRepository(SchedulerLease).insert(lease(`request-${index}`));
      }),
    );
    await Promise.all(all);

    assert.equal((await names()).length, 12);
    assert.equal(connectionInTransaction(), false);
  });

  test("a write that waits too long fails instead of joining the open transaction", async () => {
    setTransactionWaitLimitForTests(100);
    const held = holdTransaction("held");
    try {
      await held.open;
      await assert.rejects(leases().save(lease("too late")), /The database is busy/);
    } finally {
      setTransactionWaitLimitForTests(null);
      held.finish();
      await held.done;
    }

    assert.deepEqual(await names(), ["held"]);
    assert.equal(connectionInTransaction(), false);
  });
});
