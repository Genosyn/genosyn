import { AsyncLocalStorage } from "node:async_hooks";
import { EntityManager, MigrationExecutor, type QueryRunner } from "typeorm";
import { BetterSqlite3Driver } from "typeorm/driver/better-sqlite3/BetterSqlite3Driver.js";
import { AbstractSqliteQueryRunner } from "typeorm/driver/sqlite-abstract/AbstractSqliteQueryRunner.js";
import { EntityPersistExecutor } from "typeorm/persistence/EntityPersistExecutor.js";
import { RdbmsSchemaBuilder } from "typeorm/schema-builder/RdbmsSchemaBuilder.js";

/**
 * One transaction at a time on each SQLite connection.
 *
 * better-sqlite3 gives the process one connection, and TypeORM one query
 * runner over it that every request shares (`BetterSqlite3Driver
 * .createQueryRunner`). The runner keeps its transaction depth in a plain
 * field that `startTransaction` and `commitTransaction` read and write across
 * awaits, so two requests that start and commit within a few microtasks of each
 * other desynchronise it from SQLite. One request's COMMIT lands between the
 * other's depth check and its `SAVEPOINT`, which then opens a fresh SQLite
 * transaction that TypeORM believes is nested. That request fails once with
 * `TransactionNotStartedError`, and nothing is ever committed again: every
 * later save is a savepoint inside that transaction, visible to the App and
 * rolled back when it stops. An install lost fifteen hours of work this way.
 * Even when the race misses, a request whose transaction began while another
 * was open became a savepoint inside it, so its committed writes could still
 * be undone by the other request's rollback.
 *
 * The gate makes a transaction exclusive from its outermost BEGIN to the
 * COMMIT or ROLLBACK that ends it. Each place TypeORM opens one — a
 * `transaction()` call, a save, the migration and schema runners — runs in an
 * AsyncLocalStorage scope of its own, and work inside it (nested transactions,
 * repository calls on the global DataSource, anything awaited from the
 * callback) carries that scope and goes straight through. Any other
 * transaction, and any write made outside one, waits for the connection; reads
 * never wait. A wait that outlasts the limit fails rather than writing inside
 * someone else's transaction, and a transaction that holds the connection for
 * a minute is logged with where it began, so a stuck one is loud.
 *
 * Scopes come only from `AsyncLocalStorage.run`, never `enterWith`: on Node 22
 * a store entered from inside TypeORM's call chain reaches back into the
 * caller's context, so a migration at boot would have marked every job started
 * after it as part of one transaction.
 */

/** How long a write waits for another transaction before it fails. */
const WAIT_LIMIT_MS = 5 * 60_000;
/** How long a transaction may hold the connection before it is logged. */
const HOLD_WARN_MS = 60_000;
const WATCH_INTERVAL_MS = 15_000;

let waitLimitMs = WAIT_LIMIT_MS;

/** Shorten the wait so a test can reach the give-up path; null restores it. */
export function setTransactionWaitLimitForTests(ms: number | null): void {
  waitLimitMs = ms ?? WAIT_LIMIT_MS;
}

/**
 * One transaction's scope, or one write made outside any. Work spawned from a
 * transaction's callback keeps the scope after the transaction ends, and a
 * transaction it starts later takes the connection again under it.
 */
type Holder = {
  /** Where the transaction began, formatted only if it is ever logged. */
  site: Error | null;
  /**
   * Started with no scope to carry it, from a TypeORM path not wrapped below.
   * Work that carries no scope either is let through, as TypeORM always did.
   */
  anonymous: boolean;
  acquiredAt: number;
  warnedAt: number;
};

/** The transaction scope the current async context belongs to, if any. */
const context = new AsyncLocalStorage<Holder>();

function newHolder(options: { site: boolean; anonymous?: boolean }): Holder {
  return {
    site: options.site ? new Error("transaction began here") : null,
    anonymous: options.anonymous ?? false,
    acquiredAt: 0,
    warnedAt: 0,
  };
}

/** Run `fn` in a transaction scope of its own, unless it already has one. */
function scoped<T>(fn: () => T): T {
  return context.getStore() ? fn() : context.run(newHolder({ site: true }), fn);
}

let warnedUnscoped = false;

class TransactionGate {
  holder: Holder | null = null;
  private waiters: Array<() => void> = [];
  private steps: Promise<unknown> = Promise.resolve();

  /** Wait until no other transaction holds the connection, then take it. */
  async acquire(next: Holder): Promise<void> {
    if (this.holder === next) return;
    const giveUpAt = Date.now() + waitLimitMs;
    while (this.holder !== null && this.holder !== next) {
      const held = this.holder;
      const remaining = giveUpAt - Date.now();
      if (remaining <= 0) {
        const seconds = Math.round((Date.now() - held.acquiredAt) / 1000);
        throw new Error(
          `The database is busy: another change has held it for ${seconds}s, so this one was not saved. Try again.`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.holder === next) return;
    this.holder = next;
    next.acquiredAt = Date.now();
    next.warnedAt = 0;
  }

  release(holder: Holder): void {
    if (this.holder !== holder) return;
    this.holder = null;
    for (const resume of this.waiters.splice(0)) resume();
  }

  /** Whether the current async context belongs to the transaction holding the connection. */
  owns(): boolean {
    const held = this.holder;
    if (!held) return false;
    const current = context.getStore();
    return current === held || (current === undefined && held.anonymous);
  }

  /**
   * Run one start, commit or rollback at a time. Each spans awaits, and the
   * holder's own nested transactions may overlap — `Promise.all` inside a
   * transaction — so they are queued rather than allowed to interleave.
   */
  step<T>(run: () => Promise<T>): Promise<T> {
    const next = this.steps.then(run, run);
    this.steps = next.catch(() => undefined);
    return next;
  }

  warnIfHeldTooLong(now: number): void {
    const held = this.holder;
    if (!held || now - held.acquiredAt < HOLD_WARN_MS || now - held.warnedAt < HOLD_WARN_MS) return;
    held.warnedAt = now;
    const seconds = Math.round((now - held.acquiredAt) / 1000);
    // eslint-disable-next-line no-console
    console.error(
      `[db] a transaction has held the SQLite connection for ${seconds}s; other writes wait for it.` +
        (held.site?.stack ? `\n${held.site.stack}` : ""),
    );
  }
}

const gates = new WeakMap<object, TransactionGate>();
const watched = new Set<TransactionGate>();
let watchdog: ReturnType<typeof setInterval> | null = null;

function gateFor(driver: object): TransactionGate {
  let gate = gates.get(driver);
  if (!gate) {
    gate = new TransactionGate();
    gates.set(driver, gate);
    watched.add(gate);
    if (!watchdog) {
      watchdog = setInterval(() => {
        const now = Date.now();
        for (const each of watched) each.warnIfHeldTooLong(now);
      }, WATCH_INTERVAL_MS);
      watchdog.unref();
    }
  }
  return gate;
}

/** Only statements that can't write skip the queue; anything else waits its turn. */
const READ_ONLY = /^\s*(?:select|explain)\b/i;

/** The parts of TypeORM's shared runner the gate wraps. */
type SharedRunner = QueryRunner & { transactionDepth: number };
type IsolationLevel = Parameters<QueryRunner["startTransaction"]>[0];
type SqliteHandle = { inTransaction: boolean } | undefined;

const GATED = Symbol("genosyn.sqliteTransactionGate");

function gateRunner(runner: SharedRunner, gate: TransactionGate, handle: () => SqliteHandle): void {
  const marked = runner as SharedRunner & { [GATED]?: true };
  if (marked[GATED]) return;
  marked[GATED] = true;

  // TypeORM asks this before save() opens a transaction of its own. Another
  // request's transaction must read as none, so save() opens one and waits for
  // the connection instead of writing inside someone else's.
  let active = runner.isTransactionActive;
  Object.defineProperty(runner, "isTransactionActive", {
    configurable: true,
    enumerable: true,
    get: () => active && (gate.holder === null || gate.owns()),
    set: (value: boolean) => {
      active = value;
    },
  });

  const start = runner.startTransaction.bind(runner);
  const commit = runner.commitTransaction.bind(runner);
  const rollback = runner.rollbackTransaction.bind(runner);
  const query = runner.query.bind(runner) as (...args: unknown[]) => Promise<unknown>;

  /** Hand the connection on once the outermost transaction has ended. */
  const settle = (holder: Holder | null) => {
    if (holder && gate.holder === holder && !active && runner.transactionDepth === 0) {
      gate.release(holder);
    }
  };

  runner.startTransaction = async (isolationLevel?: IsolationLevel) => {
    let holder = context.getStore();
    if (!holder) {
      const held = gate.holder;
      if (held?.anonymous) {
        holder = held;
      } else {
        holder = newHolder({ site: true, anonymous: true });
        if (!warnedUnscoped) {
          warnedUnscoped = true;
          // eslint-disable-next-line no-console
          console.warn(
            "[db] a SQLite transaction began outside any scope, so work beside it may join it:",
            holder.site?.stack,
          );
        }
      }
    }
    const owner = holder;
    for (;;) {
      await gate.acquire(owner);
      // Ownership is checked again at the step's turn: a transaction can end
      // while work it started is queued behind its commit, and that work must
      // then wait for the connection like anyone else.
      const started = await gate
        .step(async () => {
          if (gate.holder !== owner) return false;
          await start(isolationLevel);
          return true;
        })
        .catch((err: unknown) => {
          if (runner.transactionDepth === 0) active = false;
          settle(owner);
          throw err;
        });
      if (started) return;
    }
  };

  runner.commitTransaction = async () => {
    const holder = gate.owns() ? gate.holder : null;
    try {
      await gate.step(() => commit());
    } finally {
      settle(holder);
    }
  };

  runner.rollbackTransaction = async () => {
    const holder = gate.owns() ? gate.holder : null;
    try {
      await gate.step(() => rollback());
    } catch (err) {
      // SQLite ends a transaction by itself on some errors, so TypeORM's
      // ROLLBACK found nothing to undo. Believe SQLite and let the next one in.
      if (holder && handle()?.inTransaction === false) {
        active = false;
        runner.transactionDepth = 0;
      }
      throw err;
    } finally {
      settle(holder);
    }
  };

  runner.query = (async (...args: unknown[]) => {
    const sql = args[0];
    if (gate.owns() || (typeof sql === "string" && READ_ONLY.test(sql))) return query(...args);
    // A write from outside the transaction holding the connection: let that
    // finish, then hold the connection for this one statement.
    const holder = newHolder({ site: false });
    await gate.acquire(holder);
    try {
      return await query(...args);
    } finally {
      gate.release(holder);
    }
  }) as SharedRunner["query"];
}

/** Give each named method a transaction scope of its own when it has none. */
function scopeMethods(prototype: object, names: string[]): void {
  const methods = prototype as Record<string, unknown>;
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== "function") {
      throw new Error(`sqliteTransactionGate: TypeORM no longer has ${name}(); review the gate`);
    }
    methods[name] = function (this: unknown, ...args: unknown[]) {
      return scoped(() => (original as (...a: unknown[]) => unknown).apply(this, args));
    };
  }
}

let installed = false;

/** Gate every better-sqlite3 query runner in this process. Idempotent. */
export function installSqliteTransactionGate(): void {
  if (installed) return;
  installed = true;

  const create = BetterSqlite3Driver.prototype.createQueryRunner;
  BetterSqlite3Driver.prototype.createQueryRunner = function (
    this: BetterSqlite3Driver,
    ...args: Parameters<typeof create>
  ) {
    const runner = create.apply(this, args);
    gateRunner(
      runner as unknown as SharedRunner,
      gateFor(this),
      () => (this as unknown as { databaseConnection?: SqliteHandle }).databaseConnection,
    );
    return runner;
  };

  // Every TypeORM path that opens a transaction for its caller. Query builders
  // open one only when asked to with `useTransaction(true)`, which nothing here
  // does; anything missed still works, unscoped, and is logged once.
  scopeMethods(EntityManager.prototype, ["transaction"]);
  scopeMethods(EntityPersistExecutor.prototype, ["execute"]);
  scopeMethods(MigrationExecutor.prototype, [
    "executePendingMigrations",
    "undoLastMigration",
    "executeMigration",
  ]);
  scopeMethods(RdbmsSchemaBuilder.prototype, ["build"]);
  scopeMethods(AbstractSqliteQueryRunner.prototype, ["clearDatabase"]);
}
