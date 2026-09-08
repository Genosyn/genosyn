import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { Repository } from "../../db/entities/Repository.js";
import { RepositoryWorkSession } from "../../db/entities/RepositoryWorkSession.js";
import { RevisionProposal } from "../../db/entities/RevisionProposal.js";
import { Routine } from "../../db/entities/Routine.js";
import { RoutineChatMessage } from "../../db/entities/RoutineChatMessage.js";
import { Run, type RunOutcomeVerdict } from "../../db/entities/Run.js";
import { RunLesson } from "../../db/entities/RunLesson.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { workSummaryLogLine } from "../runWorkSummary.js";
import { proactiveId } from "./ids.js";
import { getOwnWorkReview, OWN_WORK_REVIEW_LIMIT, OwnWorkReviewError } from "./workReview.js";

const now = new Date("2026-09-08T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
let companyId: string;
let employee: AIEmployee;
let routine: Routine;
let account: MailAccount;
let repository: Repository;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = randomUUID();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Maya",
    role: "Operations",
    slug: randomUUID(),
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Prepare weekly report",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  account = await insert(MailAccount, {
    companyId,
    connectionId: randomUUID(),
    address: "qa@example.test",
  });
  repository = await insert(Repository, {
    companyId,
    name: "Company handbook",
    slug: randomUUID(),
    gitUrl: "",
    origin: "local",
  });
});

const review = () => getOwnWorkReview(companyId, employee.id, { now });
const addRun = (values: Partial<Run> = {}) =>
  insert(Run, {
    routineId: routine.id,
    status: "completed",
    startedAt: new Date(ago(1).getTime() - 5_000),
    finishedAt: ago(1),
    logContent: workSummaryLogLine("Prepared the weekly report."),
    ...values,
  });
const addLesson = (runId: string, values: Partial<RunLesson> = {}) =>
  insert(RunLesson, {
    companyId,
    employeeId: employee.id,
    routineId: routine.id,
    runId,
    cause: "The report omitted a comparison.",
    advice: "Include the previous week.",
    createdAt: ago(1),
    ...values,
  });
const addProposal = (values: Partial<RevisionProposal> = {}) =>
  insert(RevisionProposal, {
    companyId,
    employeeId: employee.id,
    kind: "routine_body",
    targetId: routine.id,
    targetLabel: routine.name,
    baseBody: "Private full original document.",
    proposedBody: "Add a previous-week comparison.",
    rationale: "The comparison was missing.",
    createdAt: ago(1),
    ...values,
  });
const addHandover = (values: Partial<MailHandover> = {}) =>
  insert(MailHandover, {
    companyId,
    employeeId: employee.id,
    accountId: account.id,
    threadId: randomUUID(),
    status: "completed",
    instruction: "Private opening email instruction.",
    resultSummary: "Prepared a reply for review.",
    startedAt: ago(2),
    finishedAt: ago(1),
    createdAt: ago(2),
    ...values,
  });
const addSession = (values: Partial<RepositoryWorkSession> = {}) =>
  insert(RepositoryWorkSession, {
    companyId,
    employeeId: employee.id,
    repositoryId: repository.id,
    status: "ready",
    title: "Improve handbook",
    instruction: "Private opening Repository instruction.",
    reply: "Updated the handbook.",
    createdAt: ago(2),
    updatedAt: ago(1),
    finishedAt: ago(1),
    ...values,
  });
async function grantResources() {
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "read",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "read",
  });
}

test("empty history returns explicit bounded sections and validates the caller's Company", async () => {
  const result = await review();
  assert.deepEqual(result.window, {
    since: ago(30).toISOString(),
    until: now.toISOString(),
    days: 30,
  });
  for (const section of [
    result.runs,
    result.lessons,
    result.revisions.pending,
    result.revisions.decided,
    result.mailHandovers,
    result.repositoryWorkSessions,
    result.participatingRoutines,
    result.participatingRuns,
  ]) {
    assert.deepEqual(section, { items: [], limit: OWN_WORK_REVIEW_LIMIT, truncated: false });
  }
  await assert.rejects(getOwnWorkReview(randomUUID(), employee.id, { now }), OwnWorkReviewError);
  await assert.rejects(getOwnWorkReview(companyId, randomUUID(), { now }), OwnWorkReviewError);
  await assert.rejects(getOwnWorkReview(companyId, "invalid", { now }), OwnWorkReviewError);
});

test("finished Runs retain null and unverified outcomes separately from completion and Checks", async () => {
  const verdicts: (RunOutcomeVerdict | null)[] = [
    null,
    "unverified",
    "achieved",
    "unclear",
    "off_goal",
  ];
  const runs: Run[] = [];
  for (const verdict of verdicts)
    runs.push(
      await addRun({
        outcomeVerdict: verdict,
        checksVerdict: verdict === "achieved" ? "passed" : null,
        tokensIn: 310,
        tokensOut: 41,
        attempt: 3,
        checkRemediations: 2,
      }),
    );
  runs.push(await addRun({ status: "failed", outcomeNote: "The model failed." }));
  runs.push(await addRun({ status: "timeout", outcomeNote: "The deadline expired." }));
  const result = await review();
  assert.equal(result.runs.items.length, 7);
  for (const run of runs) {
    const item = result.runs.items.find((entry) => entry.id === run.id)!;
    assert.equal(item.status, run.status);
    assert.equal(item.outcomeVerdict, run.outcomeVerdict);
    assert.equal(item.checksVerdict, run.checksVerdict);
    assert.equal(item.tokensIn, run.tokensIn);
    assert.equal(item.tokensOut, run.tokensOut);
    assert.equal(item.attempt, run.attempt);
    assert.equal(item.checkRemediations, run.checkRemediations);
    assert.equal(item.durationMs, 5_000);
    assert.equal(item.summary, run.status === "completed" ? "Prepared the weekly report." : null);
  }
});

test("Run windows use finish time and exclude unfinished, skipped, interrupted, old and future work", async () => {
  for (const status of ["running", "skipped", "interrupted"] as const) await addRun({ status });
  await addRun({ finishedAt: null });
  await addRun({ finishedAt: ago(31) });
  await addRun({ finishedAt: ago(-1) });
  const first = await addRun({ startedAt: ago(40), finishedAt: ago(30) });
  const last = await addRun({ finishedAt: now });
  const result = await review();
  assert.deepEqual(
    result.runs.items.map((run) => run.id),
    [last.id, first.id],
  );
});

test("the review Routine is excluded by stable identity even after renaming, including its Lessons", async () => {
  const reviewRoutineId = proactiveId(companyId, employee.id, "improve-own-work", null);
  await insert(Routine, {
    id: reviewRoutineId,
    employeeId: employee.id,
    name: "Renamed review",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  const ownReview = await addRun({ routineId: reviewRoutineId });
  await addLesson(ownReview.id, { routineId: reviewRoutineId });
  await AppDataSource.getRepository(Routine).update(routine.id, { name: "Improve own work" });
  const business = await addRun();
  const result = await review();
  assert.deepEqual(result.excludedRoutineIds, [reviewRoutineId]);
  assert.deepEqual(
    result.runs.items.map((run) => run.id),
    [business.id],
  );
  assert.deepEqual(result.lessons.items, []);
});

test("renamed nonstable self-review Routines are excluded from Runs, Lessons, and cited revision evidence", async () => {
  const flagged = await insert(Routine, {
    employeeId: employee.id,
    name: "Improve my work",
    slug: randomUUID(),
    cronExpr: "0 15 * * 5",
    selfReviewOnly: true,
  });
  const flaggedRun = await addRun({ routineId: flagged.id });
  await addLesson(flaggedRun.id, { routineId: flagged.id });
  // Neither a familiar name nor the current enabled state defines evidence:
  // the persisted review scope continues to apply after either is changed.
  await AppDataSource.getRepository(Routine).update(flagged.id, {
    name: "Prepare the report",
    enabled: false,
  });
  const business = await addRun();
  const businessLesson = await addLesson(business.id);
  const evidenceRunIdsJson = JSON.stringify([flaggedRun.id, business.id]);
  await addProposal({ evidenceRunIdsJson });
  await addProposal({ evidenceRunIdsJson, status: "rejected", decidedAt: ago(1) });

  const result = await review();
  assert.deepEqual(
    result.runs.items.map((run) => run.id),
    [business.id],
  );
  assert.deepEqual(
    result.lessons.items.map((lesson) => lesson.id),
    [businessLesson.id],
  );
  for (const item of [...result.revisions.pending.items, ...result.revisions.decided.items]) {
    assert.deepEqual(item.evidenceRunIds, [business.id]);
    assert.equal(item.evidenceLimited, true);
  }
  assert.deepEqual(result.excludedRoutineIds, [
    proactiveId(companyId, employee.id, "improve-own-work", null),
  ]);
  assert.deepEqual(result.excludedRoutineCriteria, { selfReviewOnly: true });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(flaggedRun.id));
});

test("flagged self-review history cannot consume business evidence capacity", async () => {
  const flagged = await insert(Routine, {
    employeeId: employee.id,
    name: "Custom review",
    slug: randomUUID(),
    cronExpr: "0 15 * * 5",
    selfReviewOnly: true,
  });
  for (let index = 0; index <= OWN_WORK_REVIEW_LIMIT; index++) {
    const run = await addRun({ routineId: flagged.id, finishedAt: now });
    await addLesson(run.id, { routineId: flagged.id, createdAt: now });
  }
  const business = await addRun();
  const lesson = await addLesson(business.id);
  const result = await review();
  assert.deepEqual(
    result.runs.items.map((run) => run.id),
    [business.id],
  );
  assert.deepEqual(
    result.lessons.items.map((item) => item.id),
    [lesson.id],
  );
  assert.equal(result.runs.truncated, false);
  assert.equal(result.lessons.truncated, false);
  assert.equal(result.excludedRoutineIds.length, 1);
  assert.deepEqual(result.excludedRoutineCriteria, { selfReviewOnly: true });
});

test("other employees and companies cannot enter the packet through Routine or proposal references", async () => {
  const own = await addRun();
  for (const otherCompanyId of [companyId, randomUUID()]) {
    const other = await insert(AIEmployee, {
      companyId: otherCompanyId,
      name: "Private employee",
      role: "Private",
      slug: randomUUID(),
    });
    const otherRoutine = await insert(Routine, {
      employeeId: other.id,
      name: "PRIVATE-FOREIGN",
      slug: randomUUID(),
      cronExpr: "0 9 * * 1",
    });
    const foreign = await addRun({
      routineId: otherRoutine.id,
      logContent: workSummaryLogLine("PRIVATE-FOREIGN"),
    });
    await addLesson(foreign.id, { routineId: otherRoutine.id, cause: "PRIVATE-FOREIGN" });
    await addLesson(foreign.id, { cause: "PRIVATE-FOREIGN mismatched source" });
    await addProposal({
      companyId: otherCompanyId,
      employeeId: other.id,
      rationale: "PRIVATE-FOREIGN",
    });
  }
  await addProposal({ companyId: randomUUID(), rationale: "PRIVATE-FOREIGN forged company" });
  const result = await review();
  assert.deepEqual(
    result.runs.items.map((run) => run.id),
    [own.id],
  );
  assert.deepEqual(result.lessons.items, []);
  assert.deepEqual(result.revisions.pending.items, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FOREIGN/);
});

test("Lessons require a current own Routine and finished source Run, but that source may be older", async () => {
  const source = await addRun({ finishedAt: ago(60), startedAt: ago(61) });
  const valid = await addLesson(source.id);
  await addLesson(source.id, { dismissedAt: ago(0.5) });
  await addLesson(source.id, { createdAt: ago(31) });
  await addLesson(source.id, { createdAt: ago(-1) });
  await addLesson(source.id, { routineId: null });
  await addLesson(randomUUID());
  await addLesson((await addRun({ status: "running", finishedAt: null })).id);
  await addLesson(source.id, { companyId: randomUUID() });
  const result = await review();
  assert.deepEqual(
    result.lessons.items.map((lesson) => lesson.id),
    [valid.id],
  );
  assert.equal(result.lessons.items[0].runId, source.id);
  await AppDataSource.getRepository(Routine).delete(routine.id);
  assert.deepEqual((await review()).lessons.items, []);
});

test("pending proposals span all ages while decided history uses its decision time", async () => {
  const pending = await addProposal({ createdAt: ago(180) });
  const applied = await addProposal({
    status: "applied",
    createdAt: ago(180),
    decidedAt: ago(1),
    rationale: "Include the comparison.",
    reviewNote: "Applied after checking the evidence.",
  });
  const rejected = await addProposal({
    status: "rejected",
    decidedAt: ago(2),
    reviewNote: "Already handled by the Skill.",
  });
  await addProposal({ status: "applied", decidedAt: ago(31) });
  await addProposal({ status: "rejected", decidedAt: null });
  await addProposal({ createdAt: ago(-1) });
  const result = await review();
  assert.deepEqual(
    result.revisions.pending.items.map((item) => item.id),
    [pending.id],
  );
  assert.deepEqual(
    result.revisions.decided.items.map((item) => item.id),
    [applied.id, rejected.id],
  );
  assert.equal(result.revisions.decided.items[0].reviewNote, applied.reviewNote);
  assert.equal(result.revisions.decided.items[0].rationale, applied.rationale);
  assert.equal(result.revisions.decided.items[1].status, "rejected");
});

test("proposal evidence exposes only existing own finished business Run IDs", async () => {
  const valid = await addRun();
  const old = await addRun({ startedAt: ago(91), finishedAt: ago(90) });
  const unfinished = await addRun({ status: "running", finishedAt: null });
  const foreignRoutine = await insert(Routine, {
    employeeId: randomUUID(),
    name: "Private",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  const foreign = await addRun({ routineId: foreignRoutine.id });
  const reviewId = proactiveId(companyId, employee.id, "improve-own-work", null);
  await insert(Routine, {
    id: reviewId,
    employeeId: employee.id,
    name: "Review",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  const reviewRun = await addRun({ routineId: reviewId });
  await addProposal({
    evidenceRunIdsJson: JSON.stringify([
      valid.id,
      old.id,
      unfinished.id,
      foreign.id,
      reviewRun.id,
      randomUUID(),
      "password=not-an-id",
    ]),
  });
  const proposal = (await review()).revisions.pending.items[0];
  assert.deepEqual(proposal.evidenceRunIds, [valid.id, old.id]);
  assert.equal(proposal.evidenceLimited, true);
});

test("mail and Repository evidence requires a current Grant even for the employee's own past work", async () => {
  const handover = await addHandover();
  const session = await addSession();
  assert.deepEqual((await review()).mailHandovers.items, []);
  assert.deepEqual((await review()).repositoryWorkSessions.items, []);
  await grantResources();
  const result = await review();
  assert.deepEqual(
    result.mailHandovers.items.map((item) => item.id),
    [handover.id],
  );
  assert.deepEqual(
    result.repositoryWorkSessions.items.map((item) => item.id),
    [session.id],
  );
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({ employeeId: employee.id });
  await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({ employeeId: employee.id });
  const revoked = await review();
  assert.deepEqual(revoked.mailHandovers.items, []);
  assert.deepEqual(revoked.repositoryWorkSessions.items, []);
});

test("forged cross-company Grants, foreign owners, and absent resources disclose no mail or Repository data", async () => {
  await grantResources();
  await addHandover({ employeeId: randomUUID(), resultSummary: "PRIVATE-FOREIGN" });
  await addSession({ employeeId: randomUUID(), reply: "PRIVATE-FOREIGN" });
  await addHandover({ companyId: randomUUID(), resultSummary: "PRIVATE-FOREIGN" });
  await addSession({ companyId: randomUUID(), reply: "PRIVATE-FOREIGN" });
  await AppDataSource.getRepository(MailAccount).update(account.id, { companyId: randomUUID() });
  await AppDataSource.getRepository(Repository).update(repository.id, { companyId: randomUUID() });
  await addHandover({ resultSummary: "PRIVATE-FOREIGN forged resource" });
  await addSession({ reply: "PRIVATE-FOREIGN forged resource" });
  const result = await review();
  assert.deepEqual(result.mailHandovers.items, []);
  assert.deepEqual(result.repositoryWorkSessions.items, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FOREIGN/);
  await AppDataSource.getRepository(MailAccount).delete(account.id);
  await AppDataSource.getRepository(Repository).delete(repository.id);
  assert.deepEqual((await review()).mailHandovers.items, []);
  assert.deepEqual((await review()).repositoryWorkSessions.items, []);
});

test("mail outcomes use finish time; Repository outcomes include later review decisions without running sessions", async () => {
  await grantResources();
  const failed = await addHandover({ status: "failed", errorMessage: "Draft could not be saved." });
  for (const status of ["pending", "running"] as const) await addHandover({ status });
  await addHandover({ finishedAt: ago(31) });
  await addHandover({ finishedAt: null });
  await addHandover({ finishedAt: ago(-1) });
  const statuses = ["ready", "empty", "proposed", "published", "discarded", "failed"] as const;
  for (const status of statuses)
    await addSession({ status, createdAt: ago(90), finishedAt: ago(60), updatedAt: ago(1) });
  await addSession({ status: "running" });
  await addSession({ updatedAt: ago(31) });
  await addSession({ updatedAt: ago(-1) });
  const result = await review();
  assert.deepEqual(
    result.mailHandovers.items.map((item) => item.id),
    [failed.id],
  );
  assert.deepEqual(
    result.repositoryWorkSessions.items.map((item) => item.status).sort(),
    [...statuses].sort(),
  );
});

test("every source has a stable limit and explicit truncation without ineligible rows consuming capacity", async () => {
  await grantResources();
  for (let index = 0; index <= OWN_WORK_REVIEW_LIMIT; index++) {
    const source = await addRun({ finishedAt: new Date(ago(1).getTime() + index * 1_000) });
    await addLesson(source.id);
    await addProposal();
    await addProposal({ status: "applied", decidedAt: ago(1) });
    await addHandover();
    await addSession();
    // Newer but ineligible rows must be filtered before the source limit.
    await addRun({ status: "running", finishedAt: now });
    await addLesson(randomUUID(), { createdAt: now });
    await addProposal({ companyId: randomUUID(), createdAt: now });
    await addProposal({ companyId: randomUUID(), status: "applied", decidedAt: now });
    await addHandover({ status: "running", finishedAt: now });
    await addSession({ status: "running", updatedAt: now });
  }
  const result = await review();
  for (const section of [
    result.runs,
    result.lessons,
    result.revisions.pending,
    result.revisions.decided,
    result.mailHandovers,
    result.repositoryWorkSessions,
  ]) {
    assert.equal(section.items.length, OWN_WORK_REVIEW_LIMIT);
    assert.equal(section.truncated, true);
  }
  assert.ok(result.runs.items[0].finishedAt > result.runs.items.at(-1)!.finishedAt);
  assert.deepEqual(await review(), result, "unchanged evidence keeps deterministic IDs and order");
});

test("text is redacted and bounded without returning transcripts, opening instructions or full proposal bodies", async () => {
  await grantResources();
  const secret = "ghp_EXAMPLESECRETVALUE123456";
  const text = `**Password:** hidden-password ${secret} ` + "Bounded evidence. ".repeat(200);
  const source = await addRun({
    logContent: `[tool:read] PRIVATE-RAW-TRANSCRIPT\n${workSummaryLogLine(`Reviewed the work with ${secret}.`)}`,
    outcomeNote: text,
  });
  await addLesson(source.id, { cause: text, advice: text });
  await addProposal({
    proposedBody: text,
    baseBody: "PRIVATE-FULL-BASE-BODY",
    targetLabel: text,
    rationale: text,
    reviewNote: text,
    errorMessage: text,
  });
  await addHandover({ resultSummary: `Draft prepared with ${secret}.`, errorMessage: text });
  await addSession({ title: text, reply: `Updated the handbook with ${secret}.`, error: text });
  const result = await review();
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /hidden-password|EXAMPLESECRETVALUE|PRIVATE-RAW-TRANSCRIPT|PRIVATE-FULL-BASE-BODY|Private opening/,
  );
  assert.match(serialized, /redacted/);
  assert.equal("logContent" in result.runs.items[0], false);
  assert.equal("baseBody" in result.revisions.pending.items[0], false);
  assert.equal("proposedBody" in result.revisions.pending.items[0], false);
  assert.ok(result.runs.items[0].outcomeNote!.length <= result.limits.textChars);
  assert.ok(result.lessons.items[0].advice!.length <= result.limits.textChars);
  assert.ok(
    result.revisions.pending.items[0].proposedBodyExcerpt!.length <= result.limits.textChars,
  );
  assert.ok(result.repositoryWorkSessions.items[0].title!.length <= result.limits.labelChars);
  assert.ok(result.runs.items[0].summary!.length <= result.limits.summaryChars);
  assert.ok(result.revisions.pending.items[0].truncatedFields.includes("proposedBodyExcerpt"));
  assert.ok(result.lessons.items[0].truncatedFields.includes("cause"));
});

test("malformed or oversized historical evidence JSON is withheld with explicit limitation", async () => {
  for (const evidenceRunIdsJson of ["invalid", "{}", "[" + " ".repeat(5_000) + "]"])
    await addProposal({ evidenceRunIdsJson });
  const result = await review();
  for (const proposal of result.revisions.pending.items) {
    assert.deepEqual(proposal.evidenceRunIds, []);
    assert.equal(proposal.evidenceLimited, true);
  }
});

test("review performs only database reads and never contacts a model or external service", async (t) => {
  const source = await addRun();
  await addLesson(source.id);
  await addProposal({ evidenceRunIdsJson: JSON.stringify([source.id]) });
  await grantResources();
  await addHandover();
  await addSession();
  const queries: string[] = [];
  t.mock.method(AppDataSource.logger, "logQuery", (query: string) => {
    queries.push(query);
  });
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network access");
  });
  await review();
  assert.ok(queries.length > 0);
  assert.ok(
    queries.every((query) => /^\s*SELECT\b/i.test(query)),
    queries.join("\n"),
  );
  assert.equal(network.mock.callCount(), 0);
});

async function sharedRoutine() {
  const owner = await insert(AIEmployee, {
    role: "Reviewer",
    companyId,
    name: "Colleague",
    slug: randomUUID(),
  });
  const shared = await insert(Routine, {
    employeeId: owner.id,
    name: "Colleague report",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  const receipt = await insert(RoutineChatMessage, {
    companyId,
    routineId: shared.id,
    employeeId: employee.id,
    role: "assistant",
    status: "ok",
    content: "PRIVATE PARTICIPATION CHAT",
    actionsJson: "PRIVATE PARTICIPATION ACTIONS",
    createdAt: ago(60),
  });
  return { owner, shared, receipt };
}

test("participation is explicit separate evidence, preserves verdicts and identifies pending shared changes", async () => {
  const { owner, shared, receipt } = await sharedRoutine();
  const own = await addRun();
  const sharedRun = await addRun({
    routineId: shared.id,
    outcomeVerdict: "unverified",
    checksVerdict: null,
  });
  const pending = await addProposal({ employeeId: owner.id, targetId: shared.id });
  const result = await review();
  assert.deepEqual(
    result.runs.items.map((row) => row.id),
    [own.id],
  );
  assert.deepEqual(
    result.participatingRuns.items.map((row) => row.id),
    [sharedRun.id],
  );
  assert.equal(result.participatingRuns.items[0].outcomeVerdict, "unverified");
  assert.equal(result.participatingRuns.items[0].checksVerdict, null);
  const item = result.participatingRoutines.items[0];
  assert.equal(item.routineId, shared.id);
  assert.equal(item.ownerEmployeeId, owner.id);
  assert.equal(item.participationMessageId, receipt.id);
  assert.equal(
    item.participatedAt,
    ago(60).toISOString(),
    "participation identity does not expire with the evidence window",
  );
  assert.equal(item.pendingRevisionId, pending.id);
  assert.deepEqual(
    result.revisions.pending.items,
    [],
    "colleague proposal bodies stay outside own proposal history",
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PARTICIPATION/);
});

test("shared proposal evidence is allowed only for its exact currently participating Routine", async () => {
  const first = await sharedRoutine();
  const second = await sharedRoutine();
  const firstRun = await addRun({ routineId: first.shared.id });
  const secondRun = await addRun({ routineId: second.shared.id });
  const proposal = await addProposal({
    targetId: first.shared.id,
    evidenceRunIdsJson: JSON.stringify([firstRun.id, secondRun.id]),
  });
  const ownProposal = await addProposal({
    kind: "soul",
    targetId: null,
    evidenceRunIdsJson: JSON.stringify([firstRun.id]),
  });
  let result = await review();
  assert.deepEqual(
    result.revisions.pending.items.find((row) => row.id === proposal.id)?.evidenceRunIds,
    [firstRun.id],
  );
  assert.deepEqual(
    result.revisions.pending.items.find((row) => row.id === ownProposal.id)?.evidenceRunIds,
    [],
  );
  await AppDataSource.getRepository(RoutineChatMessage).delete(first.receipt.id);
  result = await review();
  assert.deepEqual(
    result.participatingRoutines.items.map((row) => row.id),
    [second.shared.id],
  );
  assert.deepEqual(
    result.participatingRuns.items.map((row) => row.id),
    [secondRun.id],
  );
  assert.deepEqual(
    result.revisions.pending.items.find((row) => row.id === proposal.id)?.evidenceRunIds,
    [],
  );
  assert.equal(
    result.revisions.pending.items.find((row) => row.id === proposal.id)?.evidenceLimited,
    true,
  );
});

test("shared Runs obey window, completion, review exclusion and live company ownership before limits", async () => {
  const { owner, shared } = await sharedRoutine();
  for (const status of ["running", "skipped", "interrupted"] as const)
    await addRun({ routineId: shared.id, status });
  await addRun({ routineId: shared.id, finishedAt: ago(31) });
  await addRun({ routineId: shared.id, finishedAt: ago(-1) });
  await addRun({ routineId: shared.id, finishedAt: null });
  for (let index = 0; index < OWN_WORK_REVIEW_LIMIT + 2; index++)
    await addRun({
      routineId: shared.id,
      logContent: workSummaryLogLine("api_key=private-participating-run-secret-123456789"),
    });
  let result = await review();
  assert.equal(result.participatingRuns.items.length, OWN_WORK_REVIEW_LIMIT);
  assert.equal(result.participatingRuns.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /private-participating-run-secret/);
  await AppDataSource.getRepository(Routine).update(shared.id, { selfReviewOnly: true });
  result = await review();
  assert.deepEqual(result.participatingRoutines.items, []);
  assert.deepEqual(result.participatingRuns.items, []);
  await AppDataSource.getRepository(Routine).update(shared.id, { selfReviewOnly: false });
  await AppDataSource.getRepository(AIEmployee).update(owner.id, { companyId: randomUUID() });
  result = await review();
  assert.deepEqual(result.participatingRoutines.items, []);
  assert.deepEqual(result.participatingRuns.items, []);
});
