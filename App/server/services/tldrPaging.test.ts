import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { CURSOR_OTHER_FILTERS, CURSOR_OTHER_LIST, encodeCursor, ListCursorError } from "./listPaging.js";
import { closeTestDb, initTestDb, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { listTldrs } from "./tldrs.js";

/**
 * The TLDR page's Load older follows a keyset cursor on (createdAt, id). It
 * used to send the last briefing's `createdAt` as `before`: a briefing run
 * writes many in the same second, and SQLite stamps them to the second, so
 * the same second came back page after page (the page dropped the repeats)
 * until Load older stalled; on Postgres the briefings sharing an instant
 * were skipped.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** Ready briefings stamped as SQLite stamps them, `perSecond` to a second. */
async function briefings(companyId: string, count: number, perSecond: number) {
  const rows: Array<{ id: string; createdAt: string }> = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const createdAt = new Date(Date.UTC(2026, 9, 1, 8) + Math.floor(i / perSecond) * 1_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    await AppDataSource.query(
      `INSERT INTO tldrs (id, companyId, employeeName, employeeSlug, employeeRole, status, triggerKind, periodStart, periodEnd, title, summary, body, sourceStatsJson, errorMessage, createdAt, updatedAt)
       VALUES (?, ?, 'Rey', 'rey', 'Ops', 'ready', 'schedule', ?, ?, ?, '', '', '{}', '', ?, ?)`,
      [id, companyId, createdAt, createdAt, `Briefing ${i}`, createdAt, createdAt],
    );
    rows.push({ id, createdAt });
  }
  return rows;
}

function newestFirst(rows: Array<{ id: string; createdAt: string }>): string[] {
  return [...rows]
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    )
    .map((row) => row.id);
}

describe("listTldrs, Load older by cursor", () => {
  test("reaches every briefing exactly once, 45 of them made in one second", async () => {
    const companyId = testCompanyId();
    const rows = await briefings(companyId, 110, 45);
    for (const limit of [1, 7, 30, 100]) {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 200; guard++) {
        const page = await listTldrs({ companyId, userId: "u", limit, cursor });
        assert.equal(page.total, 110);
        ids.push(...page.items.map((item) => item.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      assert.deepEqual(ids, newestFirst(rows), `limit ${limit}: every briefing once, newest first`);
    }
  });

  test("the timestamp it used to send stalled on a full second of briefings", async () => {
    const companyId = testCompanyId();
    await briefings(companyId, 80, 40);
    const first = await listTldrs({ companyId, userId: "u", limit: 30 });
    const seen = new Set(first.items.map((item) => item.id));
    const before = new Date(first.items.at(-1)!.createdAt);
    const second = await listTldrs({ companyId, userId: "u", limit: 30, before });
    const fresh = second.items.filter((item) => !seen.has(item.id));
    assert.equal(fresh.length < 30, true, `the old Load older found ${fresh.length} new of 30`);
  });

  test("a cursor is refused for another company, a before bound, or another list", async () => {
    const companyId = testCompanyId();
    await briefings(companyId, 20, 10);
    const first = await listTldrs({ companyId, userId: "u", limit: 5 });
    await assert.rejects(
      listTldrs({ companyId: testCompanyId(), userId: "u", limit: 5, cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ListCursorError && error.message === CURSOR_OTHER_FILTERS,
    );
    await assert.rejects(
      listTldrs({ companyId, userId: "u", limit: 5, before: new Date(), cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ListCursorError && error.message === CURSOR_OTHER_FILTERS,
    );
    await assert.rejects(
      listTldrs({
        companyId,
        userId: "u",
        limit: 5,
        cursor: encodeCursor("audit.events", "x", ["2026-01-01", "id"]),
      }),
      (error: unknown) => error instanceof ListCursorError && error.message === CURSOR_OTHER_LIST,
    );
  });
});
