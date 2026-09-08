import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Initiative } from "../../db/entities/Initiative.js";
import { Membership } from "../../db/entities/Membership.js";
import { Notification } from "../../db/entities/Notification.js";
import { Routine } from "../../db/entities/Routine.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  acceptInitiative,
  declineInitiative,
  getInitiative,
  InitiativeError,
  proposeInitiative,
} from "../initiatives.js";
import { getInitiativeReview } from "./initiativeReview.js";

let company: Company;
let employee: AIEmployee;
let colleague: AIEmployee;
const now = new Date("2026-09-08T12:00:00.000Z");
const spec = {
  name: "Review due experiments",
  cronExpr: "0 9 * * 1",
  body: "Read experiments past their explicit review date. Compare measured results with the required sample before proposing a decision.",
  acceptanceCriteria: "Cite measured results and leave uncertain decisions for review.",
};
const evidence = "Experiment 123 passed its recorded review date with no decision.";

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, { name: "Ideas", slug: randomUUID(), ownerId: randomUUID() });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    slug: randomUUID(),
    role: "Marketing",
  });
  colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: randomUUID(),
    role: "Operations",
  });
  await insert(Membership, { companyId: company.id, userId: company.ownerId, role: "owner" });
});

const propose = (values: Partial<Parameters<typeof proposeInitiative>[0]> = {}) =>
  proposeInitiative({
    companyId: company.id,
    employeeId: employee.id,
    title: "Review experiments when due",
    evidence,
    proposal: "Check each due experiment against its sample requirement.",
    routineSpec: spec,
    ...values,
  });
const row = (values: Partial<Initiative> = {}) =>
  insert(Initiative, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Review experiment evidence",
    evidence,
    proposal: "Finish experiments when their planned review is due.",
    routineSpecJson: JSON.stringify(spec),
    createdAt: now,
    ...values,
  });
const review = (options: Parameters<typeof getInitiativeReview>[2] = {}) =>
  getInitiativeReview(company.id, employee.id, options);
const notificationCount = () =>
  AppDataSource.getRepository(Notification).countBy({
    companyId: company.id,
    kind: "initiative_pending",
  });

test("duplicate detection retains accepted and declined feedback beyond the first history page", async () => {
  for (const status of ["accepted", "declined"] as const) {
    for (let index = 0; index < 50; index++)
      await row({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        status,
        routineSpecJson: JSON.stringify({ ...spec, body: `A different responsibility ${index}.` }),
      });
    await row({ id: "f0000000-0000-4000-8000-000000000000", status });
    await assert.rejects(propose(), status === "accepted" ? /already accepted/ : /declined/);
    await AppDataSource.getRepository(Initiative).clear();
  }
});

test("empty Initiative history returns no invented suggestions and explains the full reader", async () => {
  const result = await review();
  assert.deepEqual(result.items, []);
  assert.equal(result.nextOffset, null);
  assert.match(result.note, /get_initiative/);
});

test("Initiative review includes company feedback and can narrow to the employee and lifecycle status", async () => {
  const ownPending = await row();
  const ownDeclined = await row({
    status: "declined",
    reviewNote: "Wait for a larger sample",
    decidedAt: now,
  });
  const otherAccepted = await row({
    employeeId: colleague.id,
    status: "accepted",
    reviewNote: "Run weekly",
    createdRoutineId: randomUUID(),
    decidedAt: now,
  });
  await row({ companyId: randomUUID(), title: "Foreign history" });
  assert.deepEqual(
    new Set((await review()).items.map((item) => item.id)),
    new Set([ownPending.id, ownDeclined.id, otherAccepted.id]),
  );
  assert.deepEqual(
    new Set((await review({ mine: true })).items.map((item) => item.id)),
    new Set([ownPending.id, ownDeclined.id]),
  );
  assert.deepEqual(
    (await review({ status: "accepted" })).items.map((item) => item.id),
    [otherAccepted.id],
  );
  const declined = (await review({ mine: true, status: "declined" })).items[0];
  assert.equal(declined.reviewNoteExcerpt, "Wait for a larger sample");
  assert.equal(declined.decidedAt, now.toISOString());
  assert.equal((await review({ mine: true, status: "accepted" })).items.length, 0);
});

test("history pagination orders by date and ID without overlap at equal timestamps", async () => {
  const ids: string[] = [];
  for (let n = 0; n < 11; n++) ids.push((await row()).id);
  const seen: string[] = [];
  let offset = 0;
  for (let n = 0; n < 3; n++) {
    const page = await review({ offset });
    assert.ok(page.items.length <= 5);
    seen.push(...page.items.map((item) => item.id));
    if (n < 2) assert.equal(page.nextOffset, offset + page.items.length);
    else assert.equal(page.nextOffset, null);
    offset = page.nextOffset ?? offset;
  }
  assert.deepEqual(seen, ids.sort().reverse());
  assert.deepEqual((await review({ offset: 999 })).items, []);
});

test("history returns safe excerpts and preserves a full-record route for exact feedback", async () => {
  const note = `token=private-note ${"a".repeat(800)}`;
  const created = await row({
    title: `api_key=private-title ${"t".repeat(300)}`,
    evidence: `password=private-evidence ${"e".repeat(500)}`,
    proposal: `access_token=private-proposal ${"p".repeat(500)}`,
    reviewNote: note,
    status: "declined",
    decidedAt: now,
  });
  const result = await review();
  const item = result.items[0];
  assert.equal(item.id, created.id);
  assert.ok(item.title.length <= 140);
  assert.ok(item.evidenceExcerpt.length <= 200);
  assert.ok(item.proposalExcerpt.length <= 200);
  assert.ok(item.reviewNoteExcerpt.length <= 400);
  assert.equal(item.reviewNoteTruncated, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-title|private-evidence|private-proposal|private-note/,
  );
  assert.equal("routineSpecJson" in item, false);
  assert.equal("decidedByUserId" in item, false);
  const full = await getInitiative(company.id, created.id);
  assert.equal(full?.reviewNote, note);
  assert.equal(await getInitiative(randomUUID(), created.id), null);
});

test("escaped long metadata stays under the response budget without skipping the next row", async () => {
  const escaped = '"\\\n'.repeat(1_000);
  const ids: string[] = [];
  for (let n = 0; n < 7; n++)
    ids.push(
      (await row({ title: escaped, evidence: escaped, proposal: escaped, reviewNote: escaped })).id,
    );
  const seen: string[] = [];
  let offset = 0;
  for (let n = 0; n < 8; n++) {
    const page = await review({ offset });
    assert.ok(JSON.stringify(page, null, 2).length <= 7_500);
    seen.push(...page.items.map((item) => item.id));
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + page.items.length);
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, ids.sort().reverse());
});

test("parallel same-employee duplicate titles produce one pending Initiative and one notification", async () => {
  const results = await Promise.allSettled([
    propose(),
    propose({
      title: "REVIEW EXPERIMENTS WHEN DUE",
      routineSpec: { ...spec, body: "Different proposed brief." },
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof InitiativeError);
  assert.match(rejected.reason.message, /already pending/);
  assert.equal(await AppDataSource.getRepository(Initiative).countBy({ companyId: company.id }), 1);
  assert.equal(await notificationCount(), 1);
});

test("parallel employees cannot propose the same standing work under different titles", async () => {
  const results = await Promise.allSettled([
    propose(),
    propose({
      employeeId: colleague.id,
      title: "A new title for the same responsibility",
      routineSpec: { ...spec, name: "Renamed Routine" },
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await notificationCount(), 1);
});

test("parallel unique suggestions cannot race past five pending Initiatives per employee", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, n) =>
      propose({
        title: `Responsibility ${n}`,
        routineSpec: { ...spec, body: `Inspect source ${n} and record its evidence.` },
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
  assert.equal(results.filter((result) => result.status === "rejected").length, 3);
  assert.equal(
    await AppDataSource.getRepository(Initiative).countBy({
      companyId: company.id,
      employeeId: employee.id,
      status: "pending",
    }),
    5,
  );
  assert.equal(await notificationCount(), 5);
});

test("the pending ceiling is per employee, while duplicate responsibility detection is company-wide", async () => {
  for (let n = 0; n < 5; n++)
    await propose({
      title: `Responsibility ${n}`,
      routineSpec: { ...spec, body: `Read source ${n}.` },
    });
  const accepted = await propose({
    employeeId: colleague.id,
    title: "Different scope",
    routineSpec: { ...spec, body: "Read another source." },
  });
  assert.equal(accepted.employeeId, colleague.id);
  assert.equal(await notificationCount(), 6);
});

test("accepted standing work cannot be re-proposed by either employee after rename, pause or deletion", async () => {
  const accepted = await acceptInitiative(await propose(), { userId: company.ownerId });
  assert.ok(accepted.createdRoutineId);
  await AppDataSource.getRepository(Routine).update(
    { id: accepted.createdRoutineId! },
    { name: "Human renamed work", enabled: false },
  );
  for (const employeeId of [employee.id, colleague.id]) {
    await assert.rejects(
      propose({
        employeeId,
        title: "Different title",
        evidence: "Additional evidence",
        routineSpec: { ...spec, name: "New Routine name" },
      }),
      /already accepted/,
    );
  }
  await AppDataSource.getRepository(Routine).delete({ id: accepted.createdRoutineId! });
  await assert.rejects(propose({ title: "Recreate the deleted work" }), /already accepted/);
  assert.equal(await notificationCount(), 1);
});

test("a declined suggestion cannot repeat unchanged by retitling or changing explanatory prose", async () => {
  const declined = await declineInitiative(await propose(), {
    userId: company.ownerId,
    note: "Need new measured evidence.",
  });
  assert.equal(declined.status, "declined");
  await assert.rejects(
    propose({
      title: "Completely new title",
      proposal: "More enthusiastic case",
      routineSpec: { ...spec, name: "Renamed request" },
    }),
    /was declined/,
  );
  assert.equal(await notificationCount(), 1);
  assert.equal(
    (await review({ status: "declined", mine: true })).items[0].reviewNoteExcerpt,
    "Need new measured evidence.",
  );
});

test("changed evidence or materially changed work may be proposed after a decline", async () => {
  await declineInitiative(await propose(), {
    userId: company.ownerId,
    note: "Need a larger sample.",
  });
  const fresh = await propose({
    title: "Follow-up with measured evidence",
    evidence: "A new completed experiment supplies the missing sample.",
  });
  assert.equal(fresh.status, "pending");
  await declineInitiative(fresh, { userId: company.ownerId });
  const changed = await propose({
    title: "A narrower responsibility",
    routineSpec: {
      ...spec,
      body: "Only review the completed experiment once, then report sample uncertainty.",
    },
  });
  assert.equal(changed.status, "pending");
});

test("normalizing surrounding whitespace and line endings preserves duplicate detection", async () => {
  const body = "Read the source.\nRecord its measured outcome.";
  await propose({ routineSpec: { ...spec, body } });
  await assert.rejects(
    propose({
      title: "Retitled",
      routineSpec: { ...spec, body: `  ${body.replace(/\n/g, "\r\n")}\n  ` },
    }),
    /already pending/,
  );
});

test("missing Company, deleted employee and employee from another Company cannot propose", async () => {
  const orphanCompany = randomUUID();
  const orphan = await insert(AIEmployee, {
    companyId: orphanCompany,
    name: "Orphan",
    slug: randomUUID(),
    role: "Operations",
  });
  await assert.rejects(
    propose({ companyId: orphanCompany, employeeId: orphan.id }),
    /Company not found/,
  );
  await assert.rejects(propose({ employeeId: orphan.id }), /not found in this company/);
  await AppDataSource.getRepository(AIEmployee).delete({ id: employee.id });
  await assert.rejects(propose(), /not found in this company/);
  assert.equal(await AppDataSource.getRepository(Initiative).count(), 0);
  assert.equal(await notificationCount(), 0);
});

test("a duplicate in a different company does not prevent a valid local suggestion", async () => {
  await row({ companyId: randomUUID(), status: "accepted" });
  assert.equal((await propose()).status, "pending");
});

test("legacy malformed Initiative specs do not block unrelated valid work", async () => {
  await row({ title: "Legacy pending", routineSpecJson: "not-json" });
  await row({ status: "accepted", routineSpecJson: "{}" });
  await row({ status: "declined", routineSpecJson: "[]" });
  assert.equal((await propose()).status, "pending");
});
