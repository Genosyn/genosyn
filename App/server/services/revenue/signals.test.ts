import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Signal } from "../../db/entities/Signal.js";
import { SignalEvent, type SignalEventStatus } from "../../db/entities/SignalEvent.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../../test/dbHarness.js";
import type { QueryResult } from "../explore.js";
import {
  MAX_SIGNAL_ROWS,
  TEST_SIGNAL_ROW_CAP,
  archiveSignal,
  createSignal,
  getSignal,
  getSignalBySlug,
  isValidSignalCron,
  listRunnableSignals,
  listSignalEvents,
  listSignals,
  loadExistingDedupeKeys,
  parseActionConfig,
  restoreSignal,
  runSignalQuery,
  setQueryRunner,
  testSignal,
  uniqueSignalSlug,
  updateSignal,
} from "./signals.js";

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  setQueryRunner(null);
});
after(async () => {
  setQueryRunner(null);
  await closeTestDb();
});

const CO = "co_signals";
const OTHER = "co_other";

/** A query result in the executor's shape, from a list of plain rows. */
const queryResult = (rows: Record<string, unknown>[]): QueryResult => ({
  fields: rows.length > 0 ? Object.keys(rows[0]).map((name) => ({ name })) : [],
  rows,
  rowCount: rows.length,
  truncated: false,
  elapsedMs: 1,
});

/** The happy-path Signal every test starts from unless it says otherwise. */
async function makeSignal(over: Partial<Signal> = {}): Promise<Signal> {
  const created = await createSignal(CO, {
    name: "Trial ending",
    sql: "select 1",
    connectionId: "conn_1",
    dedupeKeyColumn: "account_id",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  if (Object.keys(over).length === 0) return created.signal;
  return insert(Signal, { ...created.signal, ...over });
}

// ───────────────────────────── cron validation ─────────────────────────────

describe("isValidSignalCron", () => {
  test("accepts an ordinary five-field expression", () => {
    assert.equal(isValidSignalCron("0 * * * *"), true);
    assert.equal(isValidSignalCron("*/15 9-17 * * 1-5"), true);
  });

  test("rejects nonsense", () => {
    assert.equal(isValidSignalCron("not a cron"), false);
    assert.equal(isValidSignalCron("* * *"), false);
  });

  test("rejects the empty string rather than defaulting", () => {
    assert.equal(isValidSignalCron(""), false);
    assert.equal(isValidSignalCron("   "), false);
  });

  test("rejects an expression node-cron accepts but cron-parser cannot schedule", () => {
    // The exact hole routines.ts closed: this saved with a 200 and never fired.
    assert.equal(isValidSignalCron("5-1 9 * * *"), false);
  });
});

// ───────────────────────────── createSignal ─────────────────────────────

describe("createSignal", () => {
  test("applies the documented defaults and starts disabled", async () => {
    const result = await createSignal(CO, { name: "Seat limit hit" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.signal.slug, "seat-limit-hit");
    assert.equal(result.signal.enabled, false);
    assert.equal(result.signal.sourceKind, "sql");
    assert.equal(result.signal.actionKind, "activity");
    assert.equal(result.signal.cron, "0 * * * *");
    assert.equal(result.signal.lastRunAt, null);
    assert.equal(result.signal.lastEventCount, 0);
    assert.equal(result.signal.archivedAt, null);
  });

  test("honours an explicit enabled flag", async () => {
    const result = await createSignal(CO, { name: "Armed", enabled: true });
    assert.equal(result.ok && result.signal.enabled, true);
  });

  test("suffixes a colliding slug instead of failing", async () => {
    await createSignal(CO, { name: "Trial ending" });
    const second = await createSignal(CO, { name: "Trial ending" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.signal.slug, "trial-ending-2");
  });

  test("slugs are per company, so two companies can both have one", async () => {
    const a = await createSignal(CO, { name: "Trial ending" });
    const b = await createSignal(OTHER, { name: "Trial ending" });
    assert.equal(a.ok && a.signal.slug, "trial-ending");
    assert.equal(b.ok && b.signal.slug, "trial-ending");
  });

  test("returns an error result for an invalid cron rather than throwing", async () => {
    const result = await createSignal(CO, { name: "Broken", cron: "nope" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not a cron expression/);
    assert.equal((await listSignals(CO)).length, 0);
  });

  test("rejects a blank name", async () => {
    const result = await createSignal(CO, { name: "   " });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Name is required/);
  });

  test("serializes actionConfig, and survives an unserializable one", async () => {
    const ok = await createSignal(CO, {
      name: "With config",
      actionConfig: { sequenceId: "seq_1" },
    });
    assert.equal(ok.ok && parseActionConfig(ok.signal).sequenceId, "seq_1");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad = await createSignal(CO, { name: "Cyclic config", actionConfig: cyclic });
    assert.equal(bad.ok, true);
    if (!bad.ok) return;
    assert.equal(bad.signal.actionConfigJson, null);
  });
});

// ───────────────────────────── updateSignal ─────────────────────────────

describe("updateSignal", () => {
  test("reports a missing signal instead of throwing", async () => {
    const result = await updateSignal(CO, "nope", { name: "x" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "Signal not found");
  });

  test("is scoped by company", async () => {
    const signal = await makeSignal();
    const result = await updateSignal(OTHER, signal.id, { name: "Hijacked" });
    assert.equal(result.ok, false);
  });

  test("rejects an invalid cron and leaves the row untouched", async () => {
    const signal = await makeSignal();
    const result = await updateSignal(CO, signal.id, { cron: "5-1 9 * * *", name: "Renamed" });
    assert.equal(result.ok, false);
    const reloaded = await getSignal(CO, signal.id);
    assert.equal(reloaded?.cron, "0 * * * *");
    assert.equal(reloaded?.name, "Trial ending");
  });

  test("does not re-derive the slug when the name changes", async () => {
    const signal = await makeSignal();
    const result = await updateSignal(CO, signal.id, { name: "Trial ending soon" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.signal.name, "Trial ending soon");
    assert.equal(result.signal.slug, "trial-ending");
  });

  test("accepts an explicit slug but refuses one already taken", async () => {
    const first = await makeSignal();
    const second = await createSignal(CO, { name: "Other" });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    const clash = await updateSignal(CO, second.signal.id, { slug: first.slug });
    assert.equal(clash.ok, false);
    if (clash.ok) return;
    assert.match(clash.error, /already in use/);

    const fine = await updateSignal(CO, second.signal.id, { slug: "Fresh Slug" });
    assert.equal(fine.ok && fine.signal.slug, "fresh-slug");
  });

  test("re-applying a signal's own slug is not a collision", async () => {
    const signal = await makeSignal();
    const result = await updateSignal(CO, signal.id, { slug: signal.slug });
    assert.equal(result.ok, true);
  });

  test("rejects a slug that slugifies to nothing", async () => {
    const signal = await makeSignal();
    const result = await updateSignal(CO, signal.id, { slug: "!!!" });
    assert.equal(result.ok, false);
  });

  test("patches every configuration field", async () => {
    const signal = await makeSignal();
    const result = await updateSignal(CO, signal.id, {
      description: "About to churn",
      connectionId: "conn_2",
      sql: "select 2",
      enabled: true,
      dedupeKeyColumn: "id",
      emailColumn: "email",
      domainColumn: "domain",
      amountColumn: "mrr_cents",
      actionKind: "create_deal",
      employeeId: "emp_1",
      cron: "*/5 * * * *",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const s = result.signal;
    assert.equal(s.description, "About to churn");
    assert.equal(s.connectionId, "conn_2");
    assert.equal(s.sql, "select 2");
    assert.equal(s.enabled, true);
    assert.equal(s.dedupeKeyColumn, "id");
    assert.equal(s.emailColumn, "email");
    assert.equal(s.domainColumn, "domain");
    assert.equal(s.amountColumn, "mrr_cents");
    assert.equal(s.actionKind, "create_deal");
    assert.equal(s.employeeId, "emp_1");
    assert.equal(s.cron, "*/5 * * * *");
  });

  test("a null actionConfig clears the stored config", async () => {
    const created = await createSignal(CO, {
      name: "Configured",
      actionConfig: { stageId: "stage_1" },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const cleared = await updateSignal(CO, created.signal.id, { actionConfig: null });
    assert.equal(cleared.ok && cleared.signal.actionConfigJson, null);
  });

  test("does not reset lastRunAt, so an edit cannot replay history", async () => {
    const ran = new Date("2026-07-01T00:00:00Z");
    const signal = await makeSignal({ lastRunAt: ran });
    const result = await updateSignal(CO, signal.id, { sql: "select 3" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.signal.lastRunAt?.getTime(), ran.getTime());
  });
});

// ───────────────────────────── archive / restore ─────────────────────────────

describe("archiveSignal", () => {
  test("stamps archivedAt and disables the signal", async () => {
    const signal = await makeSignal({ enabled: true });
    const now = new Date("2026-07-23T12:00:00Z");
    const archived = await archiveSignal(CO, signal.id, now);
    assert.equal(archived?.archivedAt?.getTime(), now.getTime());
    assert.equal(archived?.enabled, false);
  });

  test("returns null for another company's signal", async () => {
    const signal = await makeSignal();
    assert.equal(await archiveSignal(OTHER, signal.id), null);
  });

  test("keeps the events — they are the audit trail", async () => {
    const signal = await makeSignal();
    await insert(SignalEvent, {
      companyId: CO,
      signalId: signal.id,
      dedupeKey: "acct_1",
      occurredAt: new Date(),
    });
    await archiveSignal(CO, signal.id);
    const { total } = await listSignalEvents(CO, { signalId: signal.id });
    assert.equal(total, 1);
  });

  test("restore un-archives but leaves the signal disarmed", async () => {
    const signal = await makeSignal({ enabled: true });
    await archiveSignal(CO, signal.id);
    const restored = await restoreSignal(CO, signal.id);
    assert.equal(restored?.archivedAt, null);
    assert.equal(restored?.enabled, false);
  });
});

// ───────────────────────────── reads ─────────────────────────────

describe("listSignals", () => {
  test("hides archived rows unless asked", async () => {
    const keep = await makeSignal();
    const gone = await createSignal(CO, { name: "Retired" });
    assert.equal(gone.ok, true);
    if (!gone.ok) return;
    await archiveSignal(CO, gone.signal.id);

    const visible = await listSignals(CO);
    assert.deepEqual(
      visible.map((s) => s.id),
      [keep.id],
    );
    assert.equal((await listSignals(CO, { includeArchived: true })).length, 2);
  });

  test("filters on the enabled flag", async () => {
    await makeSignal();
    const armed = await createSignal(CO, { name: "Armed", enabled: true });
    assert.equal(armed.ok, true);
    if (!armed.ok) return;

    const enabled = await listSignals(CO, { enabled: true });
    assert.deepEqual(
      enabled.map((s) => s.id),
      [armed.signal.id],
    );
    assert.equal((await listSignals(CO, { enabled: false })).length, 1);
  });

  test("never leaks another company's signals", async () => {
    await makeSignal();
    await createSignal(OTHER, { name: "Theirs" });
    assert.equal((await listSignals(CO)).length, 1);
    assert.equal((await listSignals(OTHER)).length, 1);
  });
});

describe("getSignal", () => {
  test("resolves by id and by slug, scoped to the company", async () => {
    const signal = await makeSignal();
    assert.equal((await getSignal(CO, signal.id))?.id, signal.id);
    assert.equal(await getSignal(OTHER, signal.id), null);
    assert.equal((await getSignalBySlug(CO, "trial-ending"))?.id, signal.id);
    assert.equal(await getSignalBySlug(OTHER, "trial-ending"), null);
  });
});

describe("listRunnableSignals", () => {
  test("returns only enabled, un-archived signals, across companies", async () => {
    await makeSignal(); // disabled
    const armed = await createSignal(CO, { name: "Armed", enabled: true });
    const theirs = await createSignal(OTHER, { name: "Theirs", enabled: true });
    const retired = await createSignal(CO, { name: "Retired", enabled: true });
    assert.equal(armed.ok && theirs.ok && retired.ok, true);
    if (!armed.ok || !theirs.ok || !retired.ok) return;
    await archiveSignal(CO, retired.signal.id);

    const ids = (await listRunnableSignals()).map((s) => s.id).sort();
    assert.deepEqual(ids, [armed.signal.id, theirs.signal.id].sort());
  });
});

describe("uniqueSignalSlug", () => {
  test("falls back to a usable root when the name has no slug characters", async () => {
    assert.equal(await uniqueSignalSlug(CO, "!!!"), "signal");
  });

  test("walks past archived slugs, which are still held", async () => {
    const first = await makeSignal();
    await archiveSignal(CO, first.id);
    assert.equal(await uniqueSignalSlug(CO, "Trial ending"), "trial-ending-2");
  });
});

// ───────────────────────────── events ─────────────────────────────

describe("listSignalEvents", () => {
  const seed = async (
    signalId: string,
    count: number,
    status: SignalEventStatus = "new",
  ) => {
    for (let i = 0; i < count; i += 1) {
      await insert(SignalEvent, {
        companyId: CO,
        signalId,
        dedupeKey: `${status}_${i}`,
        status,
        occurredAt: new Date(Date.UTC(2026, 6, 1 + i)),
      });
    }
  };

  test("returns rows newest first with a total that ignores the page", async () => {
    const signal = await makeSignal();
    await seed(signal.id, 5);
    const page = await listSignalEvents(CO, { signalId: signal.id, limit: 2 });
    assert.equal(page.total, 5);
    assert.equal(page.rows.length, 2);
    assert.equal(page.rows[0].dedupeKey, "new_4");
  });

  test("pages with offset", async () => {
    const signal = await makeSignal();
    await seed(signal.id, 5);
    const page = await listSignalEvents(CO, { signalId: signal.id, limit: 2, offset: 2 });
    assert.equal(page.rows[0].dedupeKey, "new_2");
    assert.equal(page.total, 5);
  });

  test("filters by status and by signal", async () => {
    const a = await makeSignal();
    const bResult = await createSignal(CO, { name: "Other" });
    assert.equal(bResult.ok, true);
    if (!bResult.ok) return;
    await seed(a.id, 2, "new");
    await seed(a.id, 3, "failed");
    await seed(bResult.signal.id, 1, "new");

    assert.equal((await listSignalEvents(CO, { status: "failed" })).total, 3);
    assert.equal((await listSignalEvents(CO, { signalId: a.id })).total, 5);
    assert.equal((await listSignalEvents(CO)).total, 6);
  });

  test("clamps a silly limit instead of trusting it", async () => {
    const signal = await makeSignal();
    await seed(signal.id, 3);
    assert.equal((await listSignalEvents(CO, { limit: 0 })).rows.length, 1);
    assert.equal((await listSignalEvents(CO, { limit: 10_000 })).rows.length, 3);
    assert.equal((await listSignalEvents(CO, { offset: -5 })).rows.length, 3);
  });

  test("is scoped by company", async () => {
    const signal = await makeSignal();
    await seed(signal.id, 2);
    assert.equal((await listSignalEvents(OTHER)).total, 0);
  });
});

describe("loadExistingDedupeKeys", () => {
  test("returns only the keys asked about, for that signal", async () => {
    const signal = await makeSignal();
    const otherResult = await createSignal(CO, { name: "Other" });
    assert.equal(otherResult.ok, true);
    if (!otherResult.ok) return;

    for (const key of ["a", "b"]) {
      await insert(SignalEvent, {
        companyId: CO,
        signalId: signal.id,
        dedupeKey: key,
        occurredAt: new Date(),
      });
    }
    await insert(SignalEvent, {
      companyId: CO,
      signalId: otherResult.signal.id,
      dedupeKey: "c",
      occurredAt: new Date(),
    });

    const found = await loadExistingDedupeKeys(signal.id, ["a", "c", "z"]);
    assert.deepEqual([...found].sort(), ["a"]);
  });

  test("an empty candidate list does not query at all", async () => {
    const signal = await makeSignal();
    assert.equal((await loadExistingDedupeKeys(signal.id, [])).size, 0);
  });
});

// ───────────────────────────── parseActionConfig ─────────────────────────────

describe("parseActionConfig", () => {
  test("returns the object when the JSON is an object", () => {
    assert.deepEqual(parseActionConfig({ actionConfigJson: '{"a":1}' }), { a: 1 });
  });

  test("degrades to {} for everything that is not an object", () => {
    assert.deepEqual(parseActionConfig({ actionConfigJson: null }), {});
    assert.deepEqual(parseActionConfig({ actionConfigJson: "" }), {});
    assert.deepEqual(parseActionConfig({ actionConfigJson: "not json" }), {});
    assert.deepEqual(parseActionConfig({ actionConfigJson: "[1,2]" }), {});
    assert.deepEqual(parseActionConfig({ actionConfigJson: "3" }), {});
    assert.deepEqual(parseActionConfig({ actionConfigJson: "null" }), {});
  });

  test("never throws, whatever it is handed", () => {
    assert.doesNotThrow(() =>
      parseActionConfig({ actionConfigJson: "{" as unknown as string }),
    );
  });
});

// ───────────────────────────── the executor seam ─────────────────────────────

describe("runSignalQuery", () => {
  test("uses the injected runner when one is set", async () => {
    const signal = await makeSignal();
    setQueryRunner(async () => queryResult([{ account_id: "acct_1" }]));
    const result = await runSignalQuery(signal);
    assert.equal(result.rows.length, 1);
  });

  test("refuses a source kind that is not implemented", async () => {
    const signal = await makeSignal({ sourceKind: "stripe" });
    await assert.rejects(() => runSignalQuery(signal), /cannot run yet/);
  });

  test("refuses a signal with no connection or no SQL", async () => {
    const noConn = await makeSignal({ connectionId: null });
    await assert.rejects(() => runSignalQuery(noConn), /no connection/);
    const noSql = await makeSignal({ sql: "  " });
    await assert.rejects(() => runSignalQuery(noSql), /no SQL/);
  });

  test("refuses when the connection row has gone", async () => {
    const signal = await makeSignal();
    await assert.rejects(() => runSignalQuery(signal), /no longer exists/);
  });
});

// ───────────────────────────── testSignal ─────────────────────────────

describe("testSignal", () => {
  test("reports a missing signal in the result, not as a rejection", async () => {
    const result = await testSignal(CO, "nope");
    assert.equal(result.error, "Signal not found");
    assert.deepEqual(result.rows, []);
  });

  test("returns columns and rows from the executor", async () => {
    const signal = await makeSignal();
    setQueryRunner(async () => queryResult([{ account_id: "acct_1", mrr: 4900 }]));
    const result = await testSignal(CO, signal.id);
    assert.deepEqual(result.columns, ["account_id", "mrr"]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.error, undefined);
  });

  test("caps the rows it shows and says it did", async () => {
    const signal = await makeSignal();
    const rows = Array.from({ length: TEST_SIGNAL_ROW_CAP + 5 }, (_, i) => ({ id: i }));
    setQueryRunner(async () => queryResult(rows));
    const result = await testSignal(CO, signal.id);
    assert.equal(result.rows.length, TEST_SIGNAL_ROW_CAP);
    assert.equal(result.truncated, true);
  });

  test("falls back to the first row's keys when the driver reports no fields", async () => {
    const signal = await makeSignal();
    setQueryRunner(async () => ({
      fields: [],
      rows: [{ a: 1, b: 2 }],
      rowCount: 1,
      truncated: false,
      elapsedMs: 0,
    }));
    const result = await testSignal(CO, signal.id);
    assert.deepEqual(result.columns, ["a", "b"]);
  });

  test("surfaces a query error as text rather than rejecting", async () => {
    const signal = await makeSignal();
    setQueryRunner(async () => {
      throw new Error('relation "accounts" does not exist');
    });
    const result = await testSignal(CO, signal.id);
    assert.match(result.error ?? "", /does not exist/);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.columns, []);
  });

  test("writes nothing — no events, no lastRunAt, no lastError", async () => {
    const signal = await makeSignal();
    setQueryRunner(async () => queryResult([{ account_id: "acct_1" }]));
    await testSignal(CO, signal.id);

    const { total } = await listSignalEvents(CO, { signalId: signal.id });
    assert.equal(total, 0);
    const reloaded = await getSignal(CO, signal.id);
    assert.equal(reloaded?.lastRunAt, null);
    assert.equal(reloaded?.lastError, "");
    assert.equal(reloaded?.lastEventCount, 0);
  });

  test("a failing test run still writes nothing to the signal", async () => {
    const signal = await makeSignal();
    setQueryRunner(async () => {
      throw new Error("boom");
    });
    await testSignal(CO, signal.id);
    const reloaded = await getSignal(CO, signal.id);
    assert.equal(reloaded?.lastError, "");
    assert.equal(reloaded?.lastRunAt, null);
  });
});

describe("row caps", () => {
  test("the tick cap is far below Explore's ceiling, on purpose", () => {
    assert.ok(MAX_SIGNAL_ROWS < 5_000);
    assert.ok(TEST_SIGNAL_ROW_CAP < MAX_SIGNAL_ROWS);
  });
});
