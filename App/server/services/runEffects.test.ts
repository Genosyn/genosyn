import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Run } from "../db/entities/Run.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import { recordAudit, withAuditContext } from "./audit.js";
import {
  RUN_EFFECT_ROW_CAP,
  countEffects,
  priorAttemptEffects,
  renderEffectDigest,
  renderPriorAttemptBlock,
  runEffects,
} from "./runEffects.js";

/**
 * The effect ledger's guarantees: what comes back belongs to exactly one Run,
 * in the order the server wrote it; a retry chain can be walked backwards
 * without a foreign key to lean on and without hanging on a cycle; and the
 * rendered blocks say, in words, that the server wrote them — which is the
 * only reason a checker may weigh them differently from the transcript beside
 * them.
 */

let companyId: string;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  clock = 0;
});

/**
 * Write one ledger row directly, with an explicit ordering stamp.
 *
 * The stamp is explicit because the column's SQLite default is whole seconds:
 * a fixture that let the database fill it in would produce rows that all tie,
 * and an ordering assertion over ties passes or fails on uuid luck. Production
 * writes go through `recordAudit`, which stamps milliseconds for exactly this
 * reason — there is a test for that at the bottom of the file.
 */
let clock = 0;
async function effect(
  runId: string | null,
  action: string,
  over: Partial<AuditEvent> = {},
): Promise<AuditEvent> {
  clock += 1;
  return insert(AuditEvent, {
    companyId,
    actorKind: "ai",
    actorEmployeeId: testId("emp"),
    runId,
    action,
    targetType: "invoice",
    targetLabel: action,
    metadataJson: "",
    createdAt: new Date(Date.UTC(2026, 0, 1) + clock * 1000),
    ...over,
  });
}

describe("runEffects", () => {
  test("returns only this Run's rows, oldest first", async () => {
    const runA = testId("run");
    const runB = testId("run");
    await effect(runA, "invoice.create");
    await effect(runB, "mail.send");
    await effect(runA, "mail.send");
    await effect(null, "employee.update");

    const rows = await runEffects(runA);
    assert.deepEqual(
      rows.map((r) => r.action),
      ["invoice.create", "mail.send"],
      "the other Run's row and the human row are both absent",
    );
    assert.ok(rows[0].at instanceof Date);
  });

  test("an empty or unknown Run has no effects rather than every effect", async () => {
    await effect(testId("run"), "invoice.create");
    assert.deepEqual(await runEffects(""), []);
    assert.deepEqual(await runEffects(testId("run")), []);
  });

  test("a companyId narrows without changing what a correct caller sees", async () => {
    const runId = testId("run");
    await effect(runId, "invoice.create");
    assert.equal((await runEffects(runId, { companyId })).length, 1);
    assert.equal((await runEffects(runId, { companyId: testCompanyId() })).length, 0);
  });

  test("the row cap bounds what a runaway Run can push into a prompt", async () => {
    const runId = testId("run");
    for (let n = 0; n < 5; n++) await effect(runId, `bulk.write.${n}`);
    assert.equal((await runEffects(runId, { limit: 3 })).length, 3);
  });
});

describe("countEffects", () => {
  test("counts by action and narrows by targetType", async () => {
    const runId = testId("run");
    await effect(runId, "mail.send", { targetType: "mail_thread" });
    await effect(runId, "mail.send", { targetType: "mail_thread" });
    await effect(runId, "mail.send", { targetType: "customer" });
    await effect(runId, "invoice.create", { targetType: "invoice" });

    assert.equal(await countEffects(runId), 4, "no filter counts the whole ledger");
    assert.equal(await countEffects(runId, { action: "mail.send" }), 3);
    assert.equal(
      await countEffects(runId, { action: "mail.send", targetType: "mail_thread" }),
      2,
    );
    assert.equal(await countEffects(runId, { action: "nothing.happened" }), 0);
    assert.equal(await countEffects(""), 0);
  });
});

describe("priorAttemptEffects", () => {
  async function attempt(parentRunId: string | null): Promise<Run> {
    return insert(Run, {
      routineId: testId("routine"),
      startedAt: new Date(),
      status: "failed",
      parentRunId,
    });
  }

  test("a first attempt has no prior effects", async () => {
    const first = await attempt(null);
    assert.deepEqual(await priorAttemptEffects(first), []);
  });

  test("walks a three-deep chain and returns the oldest attempt first", async () => {
    const one = await attempt(null);
    const two = await attempt(one.id);
    const three = await attempt(two.id);
    await effect(one.id, "invoice.create");
    await effect(two.id, "mail.send");
    await effect(three.id, "mail.reply");

    const rows = await priorAttemptEffects(three);
    assert.deepEqual(
      rows.map((r) => r.action),
      ["invoice.create", "mail.send"],
      "attempt 3's own effects are not 'prior', and attempt 1 comes before attempt 2",
    );
  });

  test("a self-referential parent pointer terminates instead of hanging", async () => {
    // `parentRunId` is a bare varchar with no foreign key, so a hand-edited or
    // restored row really can point at itself. A lookup loop inside the runner
    // would hang the Run rather than fail it.
    const run = await attempt(null);
    await AppDataSource.getRepository(Run).update({ id: run.id }, { parentRunId: run.id });
    const reloaded = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    await effect(run.id, "invoice.create");
    const rows = await priorAttemptEffects(reloaded);
    assert.deepEqual(rows.map((r) => r.action), ["invoice.create"]);
  });

  test("a dangling parent id yields nothing rather than throwing", async () => {
    const orphan = await attempt(testId("run"));
    assert.deepEqual(await priorAttemptEffects(orphan), []);
  });
});

describe("the rendered blocks", () => {
  test("the digest says the server wrote it — the whole reason it counts", async () => {
    const runId = testId("run");
    await effect(runId, "mail.send", { targetLabel: "invoice chase to acme" });
    const block = renderEffectDigest(await runEffects(runId));
    assert.match(block, /written by the server at each write seam, not by the model/);
    assert.match(block, /`mail\.send` — invoice chase to acme/);
  });

  test("an empty ledger says nothing changed, not nothing is known", async () => {
    const block = renderEffectDigest([]);
    assert.match(block, /recorded no change/);
    assert.doesNotMatch(block, /write seam/, "there is no list to caveat");
  });

  test("a capped digest admits it was capped", () => {
    const rows = Array.from({ length: RUN_EFFECT_ROW_CAP }, (_, n) => ({
      action: `bulk.${n}`,
      targetType: "base_record",
      targetId: null,
      targetLabel: "",
      at: new Date(),
    }));
    assert.match(renderEffectDigest(rows), /capped at 200 entries/);
  });

  test("the retry block tells attempt 2 to verify, never to skip", () => {
    const block = renderPriorAttemptBlock(
      [
        {
          action: "mail.send",
          targetType: "mail_thread",
          targetId: null,
          targetLabel: "renewal notice",
          at: new Date(),
        },
      ],
      2,
    );
    assert.ok(block);
    assert.match(block, /This is attempt 2/);
    assert.match(block, /Verify each one before doing it again/);
    assert.match(block, /do not assume it succeeded downstream/);
  });

  test("a first attempt gets no retry block at all", () => {
    assert.equal(renderPriorAttemptBlock([], 1), null);
  });
});

describe("ambient provenance", () => {
  test("recordAudit inside a context stamps the Run, so services below the route are covered too", async () => {
    const runId = testId("run");
    await withAuditContext({ runId, conversationId: null }, async () => {
      // Deliberately not passing runId — this is the shape every one of the
      // ~150 existing write seams has, including the ones inside services that
      // never see the request.
      await recordAudit({
        companyId,
        actorEmployeeId: testId("emp"),
        action: "invoice.create",
        targetType: "invoice",
        targetLabel: "INV-1043",
      });
    });
    const rows = await runEffects(runId);
    assert.deepEqual(rows.map((r) => r.action), ["invoice.create"]);
  });

  test("an explicit null wins over the ambient value", async () => {
    const runId = testId("run");
    await withAuditContext({ runId }, async () => {
      await recordAudit({
        companyId,
        action: "backup.create",
        runId: null,
      });
    });
    assert.deepEqual(await runEffects(runId), [], "the caller said 'no Run' and meant it");
  });

  test("outside a context nothing is stamped, exactly as before", async () => {
    await recordAudit({ companyId, action: "employee.create", actorUserId: testId("user") });
    const row = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "employee.create",
    });
    assert.equal(row.runId, null);
    assert.equal(row.conversationId, null);
    assert.equal(row.actorKind, "user", "actor classification is untouched by the ledger work");
  });

  test("recordAudit stamps milliseconds, so a Run's effects read in order", async () => {
    // The regression this pins: the column's SQLite default is `datetime('now')`
    // — whole seconds — so every effect a Run recorded carried an identical
    // timestamp and "oldest first" degenerated into uuid order.
    //
    // The waits are what make this a real assertion rather than a timing
    // lottery. Milliseconds are finer than the interval between two tool calls
    // in a Run, which is the case that matters, but they are NOT finer than
    // three inserts into an in-memory database — so a loop with no delay would
    // pin nothing. Under the old whole-second stamp these three rows would still
    // tie, which is exactly what the last assertion catches.
    const runId = testId("run");
    const actions = ["first.write", "second.write", "third.write"];
    await withAuditContext({ runId }, async () => {
      for (const action of actions) {
        await recordAudit({ companyId, actorEmployeeId: testId("emp"), action });
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
    });
    const rows = await runEffects(runId);
    assert.deepEqual(rows.map((r) => r.action), actions);
    assert.equal(
      new Set(rows.map((r) => r.at.getTime())).size,
      3,
      "three writes milliseconds apart carry three distinct stamps",
    );
  });

  test("the context never reclassifies who acted", async () => {
    // A member-authority tool call passes its own actorUserId. Supplying an
    // ambient actorEmployeeId under it would relabel a human's action as the
    // AI's — an audit log that blames the wrong principal is worse than a thin
    // one, which is why AuditContext carries provenance only.
    const userId = testId("user");
    await withAuditContext({ runId: testId("run") }, async () => {
      await recordAudit({ companyId, actorUserId: userId, action: "vault.read" });
    });
    const row = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "vault.read",
    });
    assert.equal(row.actorKind, "user");
    assert.equal(row.actorUserId, userId);
    assert.equal(row.actorEmployeeId, null);
    assert.ok(row.runId, "provenance still landed");
  });
});
