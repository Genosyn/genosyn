import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { SchedulerLeaseLostError, withSchedulerLease } from "./schedulerLeases.js";

const originalDriver = config.db.driver;
const mutableDb = config.db as { driver: "sqlite" | "postgres" };
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  mutableDb.driver = originalDriver;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A local lease store, including the conditional renewal/release predicates. */
function leaseStore(renewal: () => Promise<boolean> = async () => true) {
  mutableDb.driver = "postgres";
  const row = { name: "batch", holderId: "", expiresAt: null as Date | null };
  let releases = 0;
  const repo = {
    async findOneOrFail() {
      return { ...row };
    },
    async save(value: typeof row) {
      Object.assign(row, value);
      return value;
    },
    createQueryBuilder() {
      let patch: Partial<typeof row> = {};
      let where: Record<string, unknown> = {};
      let renewing = false;
      const builder = {
        insert() {
          return builder;
        },
        values() {
          return builder;
        },
        orIgnore() {
          return builder;
        },
        update() {
          return builder;
        },
        set(value: Partial<typeof row>) {
          patch = value;
          return builder;
        },
        where(_sql: string, params: Record<string, unknown>) {
          where = params;
          return builder;
        },
        andWhere(sql: string) {
          assert.equal(sql, '"expiresAt" > clock_timestamp()');
          renewing = true;
          return builder;
        },
        async execute() {
          if (!patch.expiresAt) return { affected: 0 };
          if (renewing && !(await renewal())) return { affected: 0 };
          if (row.holderId !== where.holderId) return { affected: 0 };
          if (renewing && (!row.expiresAt || row.expiresAt.getTime() <= Date.now())) {
            return { affected: 0 };
          }
          Object.assign(row, patch);
          if (!renewing) releases++;
          return { affected: 1 };
        },
      };
      return builder;
    },
  };
  mock.method(AppDataSource, "getRepository", () => repo);
  mock.method(AppDataSource, "transaction", async (fn: (manager: unknown) => Promise<unknown>) =>
    fn({ getRepository: () => repo }),
  );
  return { row, releases: () => releases };
}

test("losing ownership aborts work, skips later dispatches, and waits for cleanup", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 10_000 });
  const store = leaseStore(async () => false);
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const cleanup = deferred<void>();
  const dispatched: string[] = [];
  const running = withSchedulerLease("batch", 6_000, async (lease) => {
    lease.assertHeld();
    dispatched.push("first");
    lease.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    started.resolve();
    try {
      await cancelled.promise;
      lease.assertHeld();
      dispatched.push("second");
    } finally {
      await cleanup.promise;
    }
  });
  const rejected = assert.rejects(running, SchedulerLeaseLostError);
  await started.promise;
  mock.timers.tick(2_000);
  await cancelled.promise;
  assert.equal(store.releases(), 0, "ownership is not released while cleanup is running");
  cleanup.resolve();
  await rejected;
  assert.deepEqual(dispatched, ["first"]);
  assert.equal(store.releases(), 1);
});

test("a hung renewal expires locally and its late success cannot revive the worker", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 10_000 });
  const renewal = deferred<boolean>();
  const renewing = deferred<void>();
  const store = leaseStore(() => {
    renewing.resolve();
    return renewal.promise;
  });
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const finish = deferred<void>();
  const running = withSchedulerLease("batch", 6_000, async (lease) => {
    lease.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    started.resolve();
    await finish.promise;
    assert.equal(lease.isHeld(), false);
    assert.throws(lease.assertHeld, SchedulerLeaseLostError);
  });
  await started.promise;
  mock.timers.tick(2_000);
  await renewing.promise;
  mock.timers.tick(4_000);
  await cancelled.promise;
  // Model a replacement replica acquiring the expired row. A stale release
  // must not shorten its lease, even when the old renewal later returns.
  store.row.holderId = "replacement";
  store.row.expiresAt = new Date(Date.now() + 6_000);
  renewal.resolve(true);
  finish.resolve();
  await running;
  assert.equal(store.row.holderId, "replacement");
  assert.equal(store.row.expiresAt.getTime(), 22_000);
  assert.equal(store.releases(), 0);
});

test("a blocked event loop cannot treat an expired lease as held", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 10_000 });
  leaseStore();
  await withSchedulerLease("batch", 6_000, async (lease) => {
    // Advance wall time without executing timer callbacks.
    mock.timers.setTime(16_000);
    assert.equal(lease.isHeld(), false);
    assert.equal(lease.signal.aborted, true);
    assert.throws(lease.assertHeld, SchedulerLeaseLostError);
  });
});

test("SQLite exposes the same cooperative interface without database ownership", async () => {
  mutableDb.driver = "sqlite";
  const result = await withSchedulerLease("batch", 6_000, async (lease) => {
    lease.assertHeld();
    assert.equal(lease.holderId, null);
    assert.equal(lease.signal.aborted, false);
    return "done";
  });
  assert.equal(result, "done");
});
