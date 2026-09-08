import assert from "node:assert/strict";
import { test } from "node:test";
import { boundWorkReviewPacket, WORK_REVIEW_PACKET_MAX_CHARS } from "./reviewPacketBudget.js";

type Row = Record<string, unknown> & { id: string; truncatedFields: string[] };
const date = "2026-09-08T12:00:00.000Z";
const id = (group: number, index: number) =>
  `${String(group).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
const text = "Useful evidence with a concrete outcome. ".repeat(12).slice(0, 400);

function makePacket(count = 20, preview = text) {
  const rows = (group: number, fields: (index: number) => Record<string, unknown>) => ({
    items: Array.from(
      { length: count },
      (_, index): Row => ({
        id: id(group, index),
        ...fields(index),
        truncatedFields: [],
      }),
    ),
    limit: 20,
    truncated: false,
  });
  const proposal = (status: string) => ({
    kind: "routine_body",
    targetId: id(10, 0),
    targetLabel: preview.slice(0, 120),
    status,
    rationale: preview,
    reviewNote:
      status === "rejected"
        ? "Keep the human review step. " + "Specific feedback. ".repeat(19)
        : null,
    errorMessage: null,
    proposedBodyExcerpt: preview,
    evidenceRunIds: Array.from({ length: 10 }, (_, index) => id(1, index)),
    evidenceLimited: false,
    createdAt: date,
    decidedAt: status === "rejected" ? date : null,
  });
  return {
    employeeId: id(9, 0),
    window: { since: "2026-08-09T12:00:00.000Z", until: date, days: 30 },
    excludedRoutineIds: [id(10, 99)],
    excludedRoutineCriteria: { selfReviewOnly: true },
    limits: {
      perSource: 20,
      textChars: 400,
      labelChars: 120,
      summaryChars: 280,
      evidenceRunIds: 10,
    },
    runs: rows(1, () => ({
      routineId: id(10, 0),
      routineName: preview.slice(0, 120),
      status: "completed",
      outcomeVerdict: "unverified",
      checksVerdict: "passed",
      outcomeNote: preview,
      summary: preview,
      summaryIsPreview: true,
      tokensIn: 40_000,
      tokensOut: 10_000,
      attempt: 3,
      checkRemediations: 1,
      durationMs: 120_000,
      startedAt: date,
      finishedAt: date,
    })),
    lessons: rows(2, (index) => ({
      routineId: id(10, 0),
      runId: id(1, index),
      cause: preview,
      advice: preview,
      createdAt: date,
    })),
    revisions: {
      pending: rows(3, () => proposal("pending")),
      decided: rows(4, () => proposal("rejected")),
    },
    mailHandovers: rows(5, () => ({
      accountId: id(11, 0),
      threadId: id(12, 0),
      status: "completed",
      mode: "work",
      sourceKind: "rule",
      summary: preview,
      summaryIsPreview: true,
      errorMessage: null,
      createdAt: date,
      startedAt: date,
      finishedAt: date,
    })),
    repositoryWorkSessions: rows(6, () => ({
      repositoryId: id(13, 0),
      title: preview.slice(0, 120),
      status: "published",
      summary: preview,
      summaryIsPreview: true,
      error: null,
      turnCount: 12,
      filesChanged: 4,
      insertions: 30,
      deletions: 8,
      createdAt: date,
      finishedAt: date,
      updatedAt: date,
    })),
  };
}

type Packet = ReturnType<typeof makePacket>;
function sections(packet: Packet) {
  return [
    packet.runs,
    packet.lessons,
    packet.revisions.pending,
    packet.revisions.decided,
    packet.mailHandovers,
    packet.repositoryWorkSessions,
  ];
}

function assertFits(packet: Packet) {
  const serialized = JSON.stringify(packet, null, 2);
  assert.ok(serialized.length <= WORK_REVIEW_PACKET_MAX_CHARS, `got ${serialized.length} chars`);
  assert.deepEqual(JSON.parse(serialized), packet);
}

test("small and empty snapshots keep their full contracts without mutating the input", () => {
  for (const source of [makePacket(0), makePacket(1, "Evidence.")]) {
    const original = structuredClone(source);
    const bounded = boundWorkReviewPacket(source);
    assertFits(bounded);
    assert.deepEqual(bounded, source);
    assert.notEqual(bounded, source);
    assert.deepEqual(source, original);
  }
});

test("a full snapshot preserves the newest evidence from every source and human feedback", () => {
  const source = makePacket();
  const original = structuredClone(source);
  assert.ok(JSON.stringify(source, null, 2).length > 60_000);
  const bounded = boundWorkReviewPacket(source);
  assertFits(bounded);
  assert.deepEqual(source, original);
  assert.deepEqual(boundWorkReviewPacket(source), bounded, "budgeting is deterministic");
  for (const [index, section] of sections(bounded).entries()) {
    const sourceSection = sections(source)[index];
    assert.ok(section.items.length >= 1, `source ${index} keeps useful evidence`);
    assert.ok(section.items.length < sourceSection.items.length);
    assert.equal(section.truncated, true);
    assert.equal(section.limit, 20);
    assert.equal(section.items[0].id, sourceSection.items[0].id);
    assert.deepEqual(
      section.items.map((row) => row.id),
      sourceSection.items.slice(0, section.items.length).map((row) => row.id),
    );
    for (const row of section.items) {
      const originalRow = sourceSection.items.find((item) => item.id === row.id)!;
      for (const [key, value] of Object.entries(row)) {
        if (key === "truncatedFields") continue;
        if (row.truncatedFields.includes(key)) {
          assert.equal(typeof value, "string");
          assert.match(value as string, /…$/u);
          assert.ok((originalRow[key] as string).startsWith((value as string).slice(0, -1)));
        } else {
          assert.deepEqual(value, originalRow[key], `${index}.${key} remains exact`);
        }
      }
    }
  }
  assert.equal(bounded.runs.items[0].outcomeVerdict, "unverified");
  assert.equal(bounded.runs.items[0].checksVerdict, "passed");
  assert.equal(
    bounded.revisions.decided.items[0].reviewNote,
    source.revisions.decided.items[0].reviewNote,
  );
  assert.deepEqual(
    bounded.revisions.decided.items[0].evidenceRunIds,
    source.revisions.decided.items[0].evidenceRunIds,
  );
});

test("one oversized row per source shortens only marked excerpts and preserves existing flags", () => {
  const source = makePacket(1);
  source.runs.truncated = true;
  source.runs.items[0].truncatedFields.push("summary");
  const bounded = boundWorkReviewPacket(source);
  assertFits(bounded);
  for (const section of sections(bounded)) assert.equal(section.items.length, 1);
  assert.equal(bounded.runs.truncated, true);
  assert.equal(bounded.lessons.truncated, false, "excerpt shortening does not claim omitted rows");
  const fields = bounded.runs.items[0].truncatedFields;
  assert.ok(fields.includes("summary"));
  assert.equal(new Set(fields).size, fields.length);
});

test("escaped Unicode previews stay inside the exact pretty-printed transport budget", () => {
  const source = makePacket(20, '\\"\n🧭'.repeat(70));
  const bounded = boundWorkReviewPacket(source);
  assertFits(bounded);
  for (const section of sections(bounded)) {
    assert.ok(section.items.length >= 1);
    for (const row of section.items) {
      for (const field of row.truncatedFields) {
        const excerpt = row[field];
        if (typeof excerpt === "string") assert.doesNotMatch(excerpt, /[\uD800-\uDBFF]…$/);
      }
    }
  }
});

test("oversized protected feedback is omitted as a flagged whole row, never silently shortened", () => {
  const source = makePacket(0);
  source.revisions.decided.items.push({
    id: id(4, 0),
    status: "rejected",
    reviewNote: "Human feedback that must remain exact. ".repeat(1_000),
    truncatedFields: [],
  });
  const bounded = boundWorkReviewPacket(source);
  assertFits(bounded);
  assert.deepEqual(bounded.revisions.decided.items, []);
  assert.equal(bounded.revisions.decided.truncated, true);
  assert.equal(source.revisions.decided.items.length, 1);
  assert.equal(source.revisions.decided.truncated, false);
});
