import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  getParticipatingRoutine,
  listParticipatingRoutines,
  RoutineParticipationError,
} from "./routineParticipation.js";
import { proactiveId } from "./proactive/ids.js";

let companyId: string;
let employee: AIEmployee;
let owner: AIEmployee;
let routine: Routine;
before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = randomUUID();
  employee = await insert(AIEmployee, {
    role: "Reviewer",
    companyId,
    name: "Participant",
    slug: randomUUID(),
  });
  owner = await insert(AIEmployee, {
    role: "Reviewer",
    companyId,
    name: "Owner",
    slug: randomUUID(),
  });
  routine = await insert(Routine, {
    employeeId: owner.id,
    name: "Shared report",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
    body: "Prepare a cited report.",
  });
});

const receipt = (values: Partial<RoutineChatMessage> = {}) =>
  insert(RoutineChatMessage, {
    companyId,
    routineId: routine.id,
    employeeId: employee.id,
    role: "assistant",
    status: "ok",
    content: "PRIVATE CHAT CONTENT",
    actionsJson: "PRIVATE ACTION DETAILS",
    ...values,
  });

test("successful participation exposes only the current Routine and receipt identity", async () => {
  const participation = await receipt();
  const proposal = await insert(RevisionProposal, {
    companyId,
    employeeId: owner.id,
    kind: "routine_body",
    targetId: routine.id,
    targetLabel: routine.name,
    baseBody: routine.body,
    proposedBody: "PRIVATE PROPOSAL BODY",
    rationale: "PRIVATE PROPOSAL RATIONALE",
  });
  const count = await AppDataSource.getRepository(RoutineChatMessage).count();
  const value = await getParticipatingRoutine(companyId, employee.id, routine.id);
  assert.equal(value.routineId, routine.id);
  assert.equal(value.ownerEmployeeId, owner.id);
  assert.equal(value.participationMessageId, participation.id);
  assert.equal(value.pendingRevisionId, proposal.id);
  assert.equal(value.body, routine.body);
  assert.equal(value.nextBodyOffset, null);
  assert.equal(value.bodyTruncated, false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  assert.equal(await AppDataSource.getRepository(RoutineChatMessage).count(), count);
});

test("mentions, unsuccessful answers and foreign company receipts do not establish participation", async () => {
  for (const values of [
    { role: "user" as const },
    { status: "working" as const },
    { status: "error" as const },
    { status: "skipped" as const },
    { status: null },
    { employeeId: owner.id },
    { companyId: randomUUID() },
  ])
    await receipt(values);
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, routine.id),
    RoutineParticipationError,
  );
  assert.deepEqual((await listParticipatingRoutines(companyId, employee.id)).items, []);
});

test("cleared chat, deleted targets, reassigned foreign targets and review Routines fail closed", async () => {
  const message = await receipt();
  await AppDataSource.getRepository(RoutineChatMessage).delete(message.id);
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, routine.id),
    RoutineParticipationError,
  );
  await receipt();
  await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, routine.id),
    RoutineParticipationError,
  );
  await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: false });
  await AppDataSource.getRepository(AIEmployee).update(owner.id, { companyId: randomUUID() });
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, routine.id),
    RoutineParticipationError,
  );
  await AppDataSource.getRepository(Routine).delete(routine.id);
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, routine.id),
    RoutineParticipationError,
  );
});

test("caller and target must exist in the same company and malformed identifiers cannot reach UUID columns", async () => {
  await receipt();
  for (const args of [
    [randomUUID(), employee.id, routine.id],
    [companyId, "bad-id", routine.id],
    [companyId, employee.id, "bad-id"],
    [companyId, randomUUID(), routine.id],
  ])
    await assert.rejects(
      getParticipatingRoutine(args[0], args[1], args[2]),
      RoutineParticipationError,
    );
});

test("a renamed stable self-review Routine is excluded even without its policy flag", async () => {
  const review = await insert(Routine, {
    id: proactiveId(companyId, owner.id, "improve-own-work", null),
    employeeId: owner.id,
    name: "Renamed review",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
    selfReviewOnly: false,
  });
  await receipt({ routineId: review.id });
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, review.id),
    RoutineParticipationError,
  );
  assert.deepEqual((await listParticipatingRoutines(companyId, employee.id)).items, []);
});

test("bounded participation listing deduplicates repeated turns and preserves newest receipts", async () => {
  for (let index = 0; index < 23; index++) {
    const row = await insert(Routine, {
      employeeId: owner.id,
      name: `Report ${index}`,
      slug: randomUUID(),
      cronExpr: "0 9 * * 1",
    });
    for (let turn = 0; turn < 2; turn++)
      await receipt({
        routineId: row.id,
        createdAt: new Date(Date.UTC(2025, 0, index + 1, turn)),
      });
  }
  const result = await listParticipatingRoutines(companyId, employee.id);
  assert.equal(result.items.length, 20);
  assert.equal(result.truncated, true);
  assert.equal(new Set(result.items.map((item) => item.routine.id)).size, 20);
  assert.equal(result.items[0].routine.name, "Report 22");
  assert.equal(result.items[0].receipt.createdAt.getUTCHours(), 1);
  assert.equal(
    (await listParticipatingRoutines(companyId, employee.id, { limit: 2 })).items.length,
    2,
  );
});

test("body chunks remain complete JSON under transport budget and can reconstruct the same version", async () => {
  await receipt();
  const body = '\\"\n\u0001🧭 Useful report instructions. '.repeat(1_000);
  await AppDataSource.getRepository(Routine).update(routine.id, { body });
  const chunks: string[] = [];
  let offset: number | null = 0;
  let hash: string | undefined;
  while (offset !== null) {
    const value = await getParticipatingRoutine(companyId, employee.id, routine.id, {
      bodyOffset: offset,
    });
    assert.ok(JSON.stringify(value, null, 2).length <= 7_500);
    assert.equal(value.bodyOffset, offset);
    assert.equal(value.bodyTruncated, true);
    assert.ok(value.body.length <= 4_000 && value.body.length > 0);
    assert.doesNotMatch(value.body, /[\uD800-\uDBFF]$/);
    hash ??= value.bodyHash;
    assert.equal(value.bodyHash, hash);
    chunks.push(value.body);
    offset = value.nextBodyOffset;
  }
  assert.equal(chunks.join(""), body);
  await AppDataSource.getRepository(Routine).update(routine.id, { body: body + "Changed" });
  assert.notEqual(
    (await getParticipatingRoutine(companyId, employee.id, routine.id)).bodyHash,
    hash,
  );
});

test("chunks redact credentials before clipping and recheck participation for every continuation", async () => {
  const message = await receipt();
  await AppDataSource.getRepository(Routine).update(routine.id, {
    body:
      "Report instructions. ".repeat(300) + "\napi_key=secret-routine-value-123456789\nContinue.",
  });
  const first = await getParticipatingRoutine(companyId, employee.id, routine.id);
  assert.ok(first.nextBodyOffset);
  const next = await getParticipatingRoutine(companyId, employee.id, routine.id, {
    bodyOffset: first.nextBodyOffset,
  });
  assert.doesNotMatch(JSON.stringify(next), /secret-routine-value/);
  for (const bodyOffset of [-1, 0.5, NaN, 999_999])
    await assert.rejects(
      getParticipatingRoutine(companyId, employee.id, routine.id, { bodyOffset }),
      RoutineParticipationError,
    );
  await AppDataSource.getRepository(RoutineChatMessage).delete(message.id);
  await assert.rejects(
    getParticipatingRoutine(companyId, employee.id, routine.id, {
      bodyOffset: first.nextBodyOffset,
    }),
    RoutineParticipationError,
  );
});
