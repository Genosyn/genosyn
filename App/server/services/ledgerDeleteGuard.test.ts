import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { bulkLedgerReview } from "./transactionReviews.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_guard";

async function makeEntry(sourceRefId: string | null): Promise<LedgerEntry> {
  return insert(LedgerEntry, {
    companyId: CO,
    date: new Date("2026-03-01T00:00:00Z"),
    memo: "test",
    source: "manual",
    sourceRefId,
    reviewStatus: "unreviewed",
  });
}

describe("ledger-entry delete guard", () => {
  test("a hand-posted journal (null sourceRefId) is deletable; a bill posting is not", async () => {
    const journal = await makeEntry(null);
    const billIssue = await makeEntry("bill_issue:abc");
    const closingEntry = await makeEntry("period-uuid");

    const result = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "delete",
      entryIds: [journal.id, billIssue.id, closingEntry.id],
    });

    assert.deepEqual(result.succeeded, [journal.id]);
    const skippedIds = result.skipped.map((s) => s.id).sort();
    assert.deepEqual(skippedIds, [billIssue.id, closingEntry.id].sort());
    for (const s of result.skipped) {
      assert.match(s.reason, /Auto-posted/);
    }

    // The journal is gone; the overloaded-manual entries survive.
    const repo = AppDataSource.getRepository(LedgerEntry);
    assert.equal(await repo.findOneBy({ id: journal.id }), null);
    assert.ok(await repo.findOneBy({ id: billIssue.id }));
    assert.ok(await repo.findOneBy({ id: closingEntry.id }));
  });
});
