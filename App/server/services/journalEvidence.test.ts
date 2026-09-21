import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  getJournalEvidence,
  JOURNAL_RESPONSE_CHAR_LIMIT,
  JournalEvidenceError,
  listJournalEvidence,
} from "./journalEvidence.js";

let companyId: string;
let employee: AIEmployee;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    slug: "ada",
    name: "Ada",
    role: "Analyst",
    soulBody: "",
  });
});

function entry(body: string, createdAt = new Date("2026-09-20T12:00:00Z")) {
  return insert(JournalEntry, {
    employeeId: employee.id,
    kind: "note",
    title: "Source coverage audit",
    body,
    createdAt,
  });
}

function assertBounded(value: unknown) {
  assert.ok(JSON.stringify(value, null, 2).length <= JOURNAL_RESPONSE_CHAR_LIMIT);
}

test("reaches evidence beyond 200 entries without skipping equal timestamps or repeating newer work", async () => {
  const repo = AppDataSource.getRepository(JournalEntry);
  const rows = await repo.save(
    Array.from({ length: 215 }, (_, index) =>
      repo.create({
        employeeId: employee.id,
        kind: "note",
        title: `Audit ${index}`,
        body: "x".repeat(10_000),
        createdAt: new Date("2026-09-20T12:00:00Z"),
      }),
    ),
  );
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await listJournalEvidence({
      companyId,
      employeeId: employee.id,
      limit: 200,
      cursor,
    });
    assert.ok(result);
    assertBounded(result);
    assert.ok(result.entries.length > 0);
    assert.ok(result.entries.every((row) => row.bodyTruncated && row.bodyLength === 10_000));
    seen.push(...result.entries.map((row) => row.id));
    if (page === 0) {
      // A live Journal keeps growing while its older evidence is read.
      await entry("newer entry", new Date("2026-09-21T12:00:00Z"));
    }
    if (!result.hasMore) {
      assert.equal(result.nextCursor, null);
      break;
    }
    assert.ok(result.nextCursor);
    cursor = result.nextCursor;
  }
  assert.deepEqual(
    seen,
    rows
      .map((row) => row.id)
      .sort()
      .reverse(),
  );
});

test("date filters include the start, exclude the end, and stay effective across cursors", async () => {
  const older = await entry("older", new Date("2026-09-19T23:59:59Z"));
  const first = await entry("start", new Date("2026-09-20T00:00:00Z"));
  const last = await entry("last", new Date("2026-09-20T23:59:59Z"));
  const newer = await entry("newer", new Date("2026-09-21T00:00:00Z"));
  const args = {
    companyId,
    employeeId: employee.id,
    limit: 1,
    since: "2026-09-20T01:00:00+01:00",
    before: "2026-09-21T00:00:00Z",
  };
  const page = await listJournalEvidence(args);
  assert.ok(page?.nextCursor);
  assert.deepEqual(
    page.entries.map((row) => row.id),
    [last.id],
  );
  const next = await listJournalEvidence({ ...args, cursor: page.nextCursor });
  assert.ok(next);
  assert.deepEqual(
    next.entries.map((row) => row.id),
    [first.id],
  );
  assert.equal(next.hasMore, false);
  assert.ok(!next.entries.some((row) => row.id === older.id || row.id === newer.id));
  await assert.rejects(listJournalEvidence({ ...args, since: args.before }), JournalEvidenceError);
});

test("cursor preserves sub-millisecond database timestamps", async () => {
  const earlier = await entry("earlier");
  const later = await entry("later");
  for (const [id, precise] of [
    [earlier.id, "2026-09-20 12:00:00.123456"],
    [later.id, "2026-09-20 12:00:00.123789"],
  ]) {
    await AppDataSource.getRepository(JournalEntry)
      .createQueryBuilder()
      .update()
      .set({ createdAt: () => ":precise" })
      .setParameter("precise", precise)
      .where("id = :id", { id })
      .execute();
  }
  const first = await listJournalEvidence({ companyId, employeeId: employee.id, limit: 1 });
  assert.ok(first?.nextCursor);
  assert.equal(first.entries[0].id, later.id);
  const next = await listJournalEvidence({
    companyId,
    employeeId: employee.id,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    next?.entries.map((row) => row.id),
    [earlier.id],
  );
});

test("exact reads reconstruct a long audit with escaped text and emoji without runtime truncation", async () => {
  const body = 'Evidence: "quoted" \\ source\n\u0000\u0001🙂 '.repeat(2_000);
  const row = await entry(body);
  const chunks: string[] = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const result = await getJournalEvidence({
      companyId,
      employeeId: employee.id,
      entryId: row.id,
      offset,
      limit: 6_000,
    });
    assert.ok(result);
    assertBounded(result);
    assert.equal(result.bodyLength, body.length);
    chunks.push(result.entry.body);
    if (!result.hasMore) {
      assert.equal(result.nextOffset, null);
      break;
    }
    assert.ok(result.nextOffset !== null && result.nextOffset > offset);
    offset = result.nextOffset;
  }
  assert.equal(chunks.join(""), body);
  const singleEmoji = await entry("🙂done");
  const emoji = await getJournalEvidence({
    companyId,
    employeeId: employee.id,
    entryId: singleEmoji.id,
    limit: 1,
  });
  assert.equal(emoji?.entry.body, "🙂");
  assert.equal(emoji?.nextOffset, 2);
});

test("list and exact reads enforce company and selected employee boundaries", async () => {
  const row = await entry("private company evidence");
  const other = await insert(AIEmployee, {
    companyId,
    slug: "other",
    name: "Other",
    role: "Writer",
    soulBody: "",
  });
  assert.equal(
    await getJournalEvidence({ companyId, employeeId: other.id, entryId: row.id }),
    null,
  );
  assert.equal(
    await getJournalEvidence({
      companyId: testCompanyId(),
      employeeId: employee.id,
      entryId: row.id,
    }),
    null,
  );
  assert.equal(
    await listJournalEvidence({ companyId: testCompanyId(), employeeId: employee.id }),
    null,
  );
  const otherList = await listJournalEvidence({ companyId, employeeId: other.id });
  assert.deepEqual(otherList?.entries, []);
  await entry("second");
  const ownList = await listJournalEvidence({ companyId, employeeId: employee.id, limit: 1 });
  assert.ok(ownList?.nextCursor);
  await assert.rejects(
    listJournalEvidence({ companyId, employeeId: other.id, cursor: ownList.nextCursor }),
    JournalEvidenceError,
  );
  await assert.rejects(
    listJournalEvidence({ companyId, employeeId: employee.id, cursor: "invalid!" }),
    JournalEvidenceError,
  );
  await assert.rejects(
    getJournalEvidence({
      companyId,
      employeeId: employee.id,
      entryId: row.id,
      offset: row.body.length + 1,
    }),
    JournalEvidenceError,
  );
});

test("empty and short entries remain complete and bounded in the compatible body field", async () => {
  const empty = await entry("");
  const short = await entry("Full short note");
  const list = await listJournalEvidence({ companyId, employeeId: employee.id });
  assert.ok(list);
  assertBounded(list);
  assert.equal(list.entries.find((row) => row.id === short.id)?.body, short.body);
  assert.ok(list.entries.every((row) => !row.bodyTruncated));
  const result = await getJournalEvidence({
    companyId,
    employeeId: employee.id,
    entryId: empty.id,
  });
  assert.ok(result);
  assert.equal(result.entry.body, "");
  assert.equal(result.nextOffset, null);
  assert.equal(result.hasMore, false);
});
