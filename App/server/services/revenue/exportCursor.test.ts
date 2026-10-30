import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { closeTestDb, initTestDb, resetTestDb, testCompanyId } from "../../test/dbHarness.js";
import { exportRevenueSnapshotPage } from "./exports.js";

/**
 * Revenue → Data quality's native exports follow a cursor of (creation time,
 * id). The cursor used to carry the time as JavaScript wrote it, to the
 * millisecond, while SQLite stamps a row's creation to the second, so the
 * "same time, later id" half of the comparison never matched: every other row
 * created in the cursor's second — an import's whole batch — was skipped.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** Rows written as SQLite writes them: creation time as text, to the second. */
async function contacts(companyId: string, count: number, second: (i: number) => string) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    await AppDataSource.query(
      `INSERT INTO contacts (id, companyId, name, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, companyId, `Imported ${i}`, `imported${i}@example.com`, second(i), second(i)],
    );
  }
  return ids;
}

async function exportAll(companyId: string, limit: number) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await exportRevenueSnapshotPage(companyId, "contacts", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.rows.map((row) => String(row.id)));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("the export never ended");
}

describe("Revenue snapshot export cursors", () => {
  test("an import's batch created in one second exports every row exactly once", async () => {
    const companyId = testCompanyId();
    const ids = await contacts(companyId, 47, (i) => (i < 40 ? "2026-01-05 09:30:00" : `2026-01-05 09:30:0${i - 39}`));
    for (const limit of [1, 4, 25, 500]) {
      const exported = await exportAll(companyId, limit);
      assert.equal(new Set(exported).size, exported.length, `limit ${limit}: no row twice`);
      assert.deepEqual(new Set(exported), new Set(ids), `limit ${limit}: every row once`);
    }
  });

  test("rows created between pages after the snapshot stay out, and none before it is skipped", async () => {
    const companyId = testCompanyId();
    const ids = await contacts(companyId, 30, () => "2026-01-05 09:30:00");
    const first = await exportRevenueSnapshotPage(companyId, "contacts", {
      limit: 10,
      asOf: new Date("2026-06-01T00:00:00.000Z"),
    });
    await contacts(companyId, 5, () => "2026-07-01 00:00:00");
    const exported = first.rows.map((row) => String(row.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await exportRevenueSnapshotPage(companyId, "contacts", { limit: 10, cursor });
      exported.push(...page.rows.map((row) => String(row.id)));
      cursor = page.nextCursor;
    }
    assert.deepEqual(exported.sort(), [...ids].sort());
  });

  test("the operation audit exports every operation a batch ran in one second exactly once", async () => {
    const companyId = testCompanyId();
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) {
      const id = randomUUID();
      ids.push(id);
      await AppDataSource.query(
        `INSERT INTO revenue_operations (id, companyId, kind, resourceType, status, requestJson, summaryJson, completedAt, createdAt, updatedAt)
         VALUES (?, ?, 'bulk', 'contact', 'completed', '{}', '{}', ?, ?, ?)`,
        [id, companyId, "2026-01-05 09:30:00.000", "2026-01-05 09:30:00", "2026-01-05 09:30:00"],
      );
    }
    const exported: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await exportRevenueSnapshotPage(companyId, "operation_audit", {
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      exported.push(...page.rows.map((row) => String(row.operationId)));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(new Set(exported).size, exported.length, "no operation twice");
    assert.deepEqual(exported.sort(), [...ids].sort(), "every operation once");
  });

  test("a cursor from before still reads on, and a forged one is refused", async () => {
    const companyId = testCompanyId();
    await contacts(companyId, 6, (i) => `2026-01-05 09:30:0${i}`);
    const first = await exportRevenueSnapshotPage(companyId, "contacts", { limit: 2 });
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    assert.equal(decoded.version, 2);
    assert.equal(decoded.timestamp, "2026-01-05 09:30:01", "the database's own text");
    const older = Buffer.from(
      JSON.stringify({ ...decoded, version: 1, timestamp: "2026-01-05T09:30:01.000Z" }),
    ).toString("base64url");
    const fromOlder = await exportRevenueSnapshotPage(companyId, "contacts", { limit: 10, cursor: older });
    assert.ok(fromOlder.rows.length >= 4, "an older cursor reads on from its instant");
    const future = Buffer.from(
      JSON.stringify({ ...decoded, timestamp: "2099-01-01 00:00:00" }),
    ).toString("base64url");
    await assert.rejects(
      exportRevenueSnapshotPage(companyId, "contacts", { cursor: future }),
      /Invalid Revenue export cursor/,
    );
    const garbled = Buffer.from(JSON.stringify({ ...decoded, timestamp: "yesterday" })).toString(
      "base64url",
    );
    await assert.rejects(
      exportRevenueSnapshotPage(companyId, "contacts", { cursor: garbled }),
      /Invalid Revenue export cursor/,
    );
  });
});
