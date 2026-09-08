import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { EntitySubscriberInterface } from "typeorm";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { Run } from "../db/entities/Run.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Skill } from "../db/entities/Skill.js";
import { AppDataSource } from "../db/datasource.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import {
  RevisionError,
  applyRevisionProposal,
  createRevisionProposal,
  getRevisionProposal,
  rejectRevisionProposal,
  serializeRevisionProposal,
} from "./revisionProposals.js";
import { recordAudit } from "./audit.js";

/**
 * The maker-checker invariants: an employee proposes only against its own
 * surfaces, nothing changes until a human applies, and apply refuses when the
 * target drifted — the reviewer approved a diff, not a blind overwrite.
 */

let companyId: string;
let employee: AIEmployee;
let skill: Skill;
let routine: Routine;

async function evidenceRun(overrides: Partial<Run> = {}) {
  return insert(Run, {
    routineId: routine.id,
    status: "completed",
    startedAt: new Date("2025-01-01T00:00:00Z"),
    finishedAt: new Date("2025-01-01T00:01:00Z"),
    ...overrides,
  });
}

async function reviewRun(ownerId = employee.id, selfReviewOnly = true) {
  const review = await insert(Routine, {
    employeeId: ownerId,
    name: "Improve my work",
    slug: `review-${randomUUID()}`,
    cronExpr: "0 15 * * 5",
    body: "Review my own work.",
    selfReviewOnly,
  });
  return insert(Run, {
    routineId: review.id,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
  });
}

function soulInput(evidenceRunIds: string[] = []) {
  return {
    kind: "soul" as const,
    proposedBody: "Be direct. Cite evidence.",
    rationale: "Past results show that claims need a source.",
    evidenceRunIds,
  };
}

async function rejectAt(proposal: RevisionProposal, date: string) {
  const rejected = await rejectRevisionProposal(proposal, {
    userId: testId("owner"),
    note: "Need more evidence.",
  });
  rejected.decidedAt = new Date(date);
  await AppDataSource.getRepository(RevisionProposal).save(rejected);
}

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "Be direct.",
  });
  skill = await insert(Skill, {
    employeeId: employee.id,
    name: "Digest writing",
    slug: "digest-writing",
    body: "Write short digests.",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "Post the digest.",
    acceptanceCriteria: "The digest was posted.",
  });
  await insert(Membership, { companyId, userId: testId("owner"), role: "owner" });
});

describe("createRevisionProposal", () => {
  test("snapshots the base body and notifies the humans who can apply it", async () => {
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "skill",
      targetId: skill.id,
      proposedBody: "Write short digests.\nAlways name the source thread.",
      rationale: "Two off-goal runs missed the source thread.",
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.baseBody, "Write short digests.");
    assert.equal(proposal.targetLabel, "Digest writing");
    const bells = await AppDataSource.getRepository(Notification).findBy({
      kind: "revision_pending",
    });
    assert.equal(bells.length, 1);
    assert.match(bells[0].title, /Digest writing/);
  });

  test("refuses a target that is not the employee's own", async () => {
    const other = await insert(AIEmployee, {
      companyId,
      name: "Eve",
      slug: "eve",
      role: "Writer",
      soulBody: "",
    });
    const foreignSkill = await insert(Skill, {
      employeeId: other.id,
      name: "Theirs",
      slug: "theirs",
      body: "x",
    });
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, {
        kind: "skill",
        targetId: foreignSkill.id,
        proposedBody: "mine now",
        rationale: "no",
      }),
      RevisionError,
    );
  });

  test("a soul proposal names no target, and an identical body is refused", async () => {
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, {
        kind: "soul",
        targetId: skill.id,
        proposedBody: "x",
        rationale: "r",
      }),
      RevisionError,
    );
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, {
        kind: "soul",
        proposedBody: "Be direct.",
        rationale: "r",
      }),
      RevisionError,
    );
  });

  test("clearing acceptance criteria is a legitimate proposal; clearing a soul is not", async () => {
    const cleared = await createRevisionProposal(companyId, employee.id, {
      kind: "routine_criteria",
      targetId: routine.id,
      proposedBody: "",
      rationale: "The criteria grade a report this routine no longer produces.",
    });
    assert.equal(cleared.proposedBody, "");
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, {
        kind: "soul",
        proposedBody: "   ",
        rationale: "r",
      }),
      RevisionError,
    );
  });

  test("one pending proposal per target at a time", async () => {
    await createRevisionProposal(companyId, employee.id, {
      kind: "routine_body",
      targetId: routine.id,
      proposedBody: "Post the digest to #general.",
      rationale: "r",
    });
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, {
        kind: "routine_body",
        targetId: routine.id,
        proposedBody: "Post the digest to #random.",
        rationale: "r",
      }),
      /already pending/,
    );
  });
});

describe("applyRevisionProposal", () => {
  test("writes the target, stamps the decision, audits the human, journals the employee", async () => {
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "soul",
      proposedBody: "Be direct. Cite evidence.",
      rationale: "Off-goal runs claimed success without evidence.",
    });
    const applied = await applyRevisionProposal(proposal, {
      userId: testId("owner"),
      note: "Good change.",
    });
    assert.equal(applied.status, "applied");
    const fresh = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(fresh.soulBody, "Be direct. Cite evidence.");
    const audit = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "revision.apply",
    });
    assert.equal(audit.length, 1);
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({
      employeeId: employee.id,
    });
    assert.equal(journal.length, 1);
    assert.match(journal[0].title, /was applied/);
  });

  test("refuses on drift and keeps the proposal pending with the reason in place", async () => {
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "skill",
      targetId: skill.id,
      proposedBody: "Write short digests. Name sources.",
      rationale: "r",
    });
    // A human edits the skill between proposal and review.
    skill.body = "Write LONG digests.";
    await AppDataSource.getRepository(Skill).save(skill);

    await assert.rejects(
      applyRevisionProposal(proposal, { userId: testId("owner") }),
      /changed since this was proposed/,
    );
    const kept = await getRevisionProposal(companyId, proposal.id);
    assert.equal(kept?.status, "pending");
    assert.match(kept?.errorMessage ?? "", /changed since/);
    const fresh = await AppDataSource.getRepository(Skill).findOneByOrFail({ id: skill.id });
    assert.equal(fresh.body, "Write LONG digests.");
  });

  test("a decided proposal cannot be decided again", async () => {
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "routine_body",
      targetId: routine.id,
      proposedBody: "Post the digest to #general.",
      rationale: "r",
    });
    await rejectRevisionProposal(proposal, { userId: testId("owner"), note: "Not yet." });
    await assert.rejects(applyRevisionProposal(proposal, { userId: testId("owner") }), /already/);
    const routineAfter = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: routine.id,
    });
    assert.equal(routineAfter.body, "Post the digest.");
  });

  test("routine_criteria writes the criteria, not the brief", async () => {
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "routine_criteria",
      targetId: routine.id,
      proposedBody: "The digest was posted to #general before 04:00.",
      rationale: "r",
    });
    await applyRevisionProposal(proposal, { userId: testId("owner") });
    const fresh = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(fresh.acceptanceCriteria, "The digest was posted to #general before 04:00.");
    assert.equal(fresh.body, "Post the digest.");
  });
});

describe("serialization", () => {
  test("evidence run ids survive the JSON round-trip and junk parses to empty", async () => {
    const run = await evidenceRun();
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "soul",
      proposedBody: "Be direct. Be brief.",
      rationale: "r",
      evidenceRunIds: [run.id],
    });
    const dto = serializeRevisionProposal(proposal);
    assert.deepEqual(dto.evidenceRunIds, [run.id]);
    proposal.evidenceRunIdsJson = "{broken";
    assert.deepEqual(serializeRevisionProposal(proposal).evidenceRunIds, []);
  });
});

describe("revision evidence validation", () => {
  test("accepts owned finished completed, failed, and timeout Runs, preserving order", async () => {
    const completed = await evidenceRun();
    const failed = await evidenceRun({ status: "failed" });
    const timeout = await evidenceRun({ status: "timeout" });
    const proposal = await createRevisionProposal(
      companyId,
      employee.id,
      soulInput([timeout.id.toUpperCase(), completed.id, failed.id]),
    );
    assert.deepEqual(serializeRevisionProposal(proposal).evidenceRunIds, [
      timeout.id,
      completed.id,
      failed.id,
    ]);
    assert.equal(proposal.reviewRunId, null);
  });

  test("rejects malformed, duplicate, and oversized evidence instead of silently dropping it", async () => {
    const run = await evidenceRun();
    const invalidEvidence: unknown[] = [
      [run.id, "not-a-uuid"],
      [run.id, run.id],
      [run.id, run.id.toUpperCase()],
      Array.from({ length: 11 }, () => randomUUID()),
      null,
      "not-an-array",
      [null],
    ];
    for (const evidence of invalidEvidence) {
      await assert.rejects(
        createRevisionProposal(companyId, employee.id, soulInput(evidence as string[])),
        RevisionError,
      );
    }
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 0);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });

  test("rejects unfinished, skipped, interrupted, and falsely terminal evidence", async () => {
    for (const status of ["running", "skipped", "interrupted"] as const) {
      const run = await evidenceRun({ status });
      await assert.rejects(
        createRevisionProposal(companyId, employee.id, soulInput([run.id])),
        /own existing finished/,
      );
    }
    const unfinished = await evidenceRun({ finishedAt: null });
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput([unfinished.id])),
      /own existing finished/,
    );
  });

  test("rejects fake and deleted Runs and evidence whose Routine was deleted", async () => {
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput([randomUUID()])),
      /own existing finished/,
    );
    const deleted = await evidenceRun();
    await AppDataSource.getRepository(Run).delete(deleted.id);
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput([deleted.id])),
      /own existing finished/,
    );
    const orphan = await evidenceRun();
    await AppDataSource.getRepository(Routine).delete(routine.id);
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput([orphan.id])),
      /own existing finished/,
    );
  });

  test("rejects another employee's evidence in both the same and a foreign company", async () => {
    for (const otherCompanyId of [companyId, testCompanyId()]) {
      const other = await insert(AIEmployee, {
        companyId: otherCompanyId,
        name: "Other",
        slug: randomUUID(),
        role: "Writer",
        soulBody: "Be helpful.",
      });
      const otherReview = await reviewRun(other.id);
      const evidence = await evidenceRun({ routineId: otherReview.routineId });
      await assert.rejects(
        createRevisionProposal(companyId, employee.id, soulInput([evidence.id])),
        /own existing finished/,
      );
    }
    const own = await evidenceRun();
    await assert.rejects(
      createRevisionProposal(testCompanyId(), employee.id, soulInput([own.id])),
      /Employee not found/,
    );
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });
});

describe("trusted self-review provenance", () => {
  test("persists trusted provenance without applying the proposed change", async () => {
    const review = await reviewRun();
    const evidence = await evidenceRun();
    const proposal = await createRevisionProposal(
      companyId,
      employee.id,
      soulInput([evidence.id]),
      { reviewRunId: review.id },
    );
    assert.equal(proposal.reviewRunId, review.id);
    assert.equal(proposal.status, "pending");
    assert.equal(
      (await AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: employee.id })).soulBody,
      "Be direct.",
    );
    assert.equal(await AppDataSource.getRepository(Notification).count(), 1);
  });

  test("rejects invalid, missing, finished, and ordinary Routine review Runs", async () => {
    const ordinary = await reviewRun(employee.id, false);
    const finished = await reviewRun();
    await AppDataSource.getRepository(Run).update(finished.id, {
      status: "completed",
      finishedAt: new Date(),
    });
    const inconsistent = await reviewRun();
    await AppDataSource.getRepository(Run).update(inconsistent.id, { finishedAt: new Date() });
    for (const reviewRunId of [
      "not-a-uuid",
      "",
      randomUUID(),
      ordinary.id,
      finished.id,
      inconsistent.id,
    ]) {
      await assert.rejects(
        createRevisionProposal(companyId, employee.id, soulInput(), { reviewRunId }),
        /running/,
      );
    }
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 0);
  });

  test("rejects another employee's review and deleted review provenance", async () => {
    const other = await insert(AIEmployee, {
      companyId,
      name: "Other",
      slug: "other",
      role: "Writer",
      soulBody: "",
    });
    const foreign = await reviewRun(other.id);
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput(), { reviewRunId: foreign.id }),
      /own running/,
    );
    const deleted = await reviewRun();
    await AppDataSource.getRepository(Run).delete(deleted.id);
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput(), { reviewRunId: deleted.id }),
      /own running/,
    );
    const orphan = await reviewRun();
    await AppDataSource.getRepository(Routine).delete(orphan.routineId);
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput(), { reviewRunId: orphan.id }),
      /own running/,
    );
  });

  test("self-review cannot propose acceptance criteria changes", async () => {
    const review = await reviewRun();
    await assert.rejects(
      createRevisionProposal(
        companyId,
        employee.id,
        {
          kind: "routine_criteria",
          targetId: routine.id,
          proposedBody: "",
          rationale: "Remove the criteria.",
        },
        { reviewRunId: review.id },
      ),
      /cannot propose acceptance criteria/,
    );
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 0);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });

  test("one proposal per review Run across targets, including parallel calls", async () => {
    const review = await reviewRun();
    const results = await Promise.allSettled([
      createRevisionProposal(companyId, employee.id, soulInput(), { reviewRunId: review.id }),
      createRevisionProposal(
        companyId,
        employee.id,
        {
          kind: "skill",
          targetId: skill.id,
          proposedBody: "Write cited digests.",
          rationale: "Sources are missing.",
        },
        { reviewRunId: review.id },
      ),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const refused = results.find((result) => result.status === "rejected");
    assert.ok(refused?.status === "rejected");
    assert.match(String(refused.reason), /already created a proposal/);
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 1);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 1);
  });

  for (const decision of ["applied", "rejected"] as const) {
    test(`a ${decision} proposal still consumes the Run allowance and human review stays unchanged`, async () => {
      const review = await reviewRun();
      const proposal = await createRevisionProposal(companyId, employee.id, soulInput(), {
        reviewRunId: review.id,
      });
      const decide = decision === "applied" ? applyRevisionProposal : rejectRevisionProposal;
      const decided = await decide(proposal, {
        userId: testId("owner"),
        note: "Reviewed by a human.",
      });
      assert.equal(decided.status, decision);
      assert.equal(decided.reviewRunId, review.id);
      assert.equal(
        (await AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: employee.id }))
          .soulBody,
        decision === "applied" ? proposal.proposedBody : "Be direct.",
      );
      assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 1);
      assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 1);
      await assert.rejects(
        createRevisionProposal(
          companyId,
          employee.id,
          {
            kind: "skill",
            targetId: skill.id,
            proposedBody: "Write cited digests.",
            rationale: "Sources are missing.",
          },
          { reviewRunId: review.id },
        ),
        /already created a proposal/,
      );
      assert.equal(await AppDataSource.getRepository(Notification).count(), 1);
    });
  }

  test("untrusted payload provenance is ignored and ordinary proposals remain supported", async () => {
    const spoofed = { ...soulInput(), reviewRunId: randomUUID() };
    const proposal = await createRevisionProposal(companyId, employee.id, spoofed);
    assert.equal(proposal.reviewRunId, null);
    await rejectRevisionProposal(proposal, { userId: testId("owner") });
    const ordinaryRetry = await createRevisionProposal(companyId, employee.id, soulInput());
    assert.equal(ordinaryRetry.status, "pending");
    assert.equal(ordinaryRetry.reviewRunId, null);
  });
});

describe("rejected automatic suggestions", () => {
  test("a completed self-review cannot become new business evidence for an automatic retry", async () => {
    const evidence = await evidenceRun();
    const initialReview = await reviewRun();
    const proposal = await createRevisionProposal(
      companyId,
      employee.id,
      soulInput([evidence.id]),
      { reviewRunId: initialReview.id },
    );
    await rejectAt(proposal, "2025-01-10T00:00:00Z");
    const priorReview = await reviewRun();
    await AppDataSource.getRepository(Run).update(priorReview.id, {
      status: "completed",
      startedAt: new Date("2025-01-11T00:00:00Z"),
      finishedAt: new Date("2025-01-11T00:01:00Z"),
    });
    const nextReview = await reviewRun();
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput([priorReview.id]), {
        reviewRunId: nextReview.id,
      }),
      /own existing finished/,
    );
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 1);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 1);

    const ordinary = await createRevisionProposal(
      companyId,
      employee.id,
      soulInput([priorReview.id]),
    );
    assert.equal(ordinary.reviewRunId, null);
    assert.deepEqual(serializeRevisionProposal(ordinary).evidenceRunIds, [priorReview.id]);
  });

  test("identical rejected text needs new finished evidence after the most recent rejection", async () => {
    const evidence = await evidenceRun();
    const firstReview = await reviewRun();
    const first = await createRevisionProposal(companyId, employee.id, soulInput([evidence.id]), {
      reviewRunId: firstReview.id,
    });
    await rejectAt(first, "2025-01-10T00:00:00Z");
    const nextReview = await reviewRun();
    const oldUnseen = await evidenceRun({ finishedAt: new Date("2025-01-05T00:00:00Z") });
    for (const ids of [[], [evidence.id], [oldUnseen.id]]) {
      await assert.rejects(
        createRevisionProposal(companyId, employee.id, soulInput(ids), {
          reviewRunId: nextReview.id,
        }),
        /new work finished after/,
      );
    }
    const newEvidence = await evidenceRun({ finishedAt: new Date("2025-01-11T00:00:00Z") });
    const second = await createRevisionProposal(
      companyId,
      employee.id,
      soulInput([newEvidence.id]),
      { reviewRunId: nextReview.id },
    );
    await rejectAt(second, "2025-01-12T00:00:00Z");
    const thirdReview = await reviewRun();
    await assert.rejects(
      createRevisionProposal(companyId, employee.id, soulInput([newEvidence.id]), {
        reviewRunId: thirdReview.id,
      }),
      /new work finished after/,
    );
    const latest = await evidenceRun({ finishedAt: new Date("2025-01-13T00:00:00Z") });
    const third = await createRevisionProposal(companyId, employee.id, soulInput([latest.id]), {
      reviewRunId: thirdReview.id,
    });
    assert.equal(third.status, "pending");
    assert.equal(await AppDataSource.getRepository(Notification).count(), 3);
  });

  test("a changed proposal or changed base is not an identical rejected suggestion", async () => {
    const initial = await createRevisionProposal(companyId, employee.id, soulInput());
    await rejectRevisionProposal(initial, { userId: testId("owner") });
    const review = await reviewRun();
    const revised = await createRevisionProposal(
      companyId,
      employee.id,
      { ...soulInput(), proposedBody: "Be direct. Include the source and uncertainty." },
      { reviewRunId: review.id },
    );
    await rejectRevisionProposal(revised, { userId: testId("owner") });
    await AppDataSource.getRepository(AIEmployee).update(employee.id, {
      soulBody: "Be direct. New instructions.",
    });
    const nextReview = await reviewRun();
    const rebased = await createRevisionProposal(companyId, employee.id, soulInput(), {
      reviewRunId: nextReview.id,
    });
    assert.equal(rebased.baseBody, "Be direct. New instructions.");
  });
});

describe("concurrent proposal creation", () => {
  test("parallel ordinary proposals cannot create two pending revisions of one target", async () => {
    const results = await Promise.allSettled([
      createRevisionProposal(companyId, employee.id, soulInput()),
      createRevisionProposal(companyId, employee.id, {
        ...soulInput(),
        proposedBody: "Be direct. Include examples.",
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const refused = results.find((result) => result.status === "rejected");
    assert.ok(refused?.status === "rejected");
    assert.match(String(refused.reason), /already pending/);
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 1);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 1);
  });

  test("expected declines preserve audit writes sharing SQLite's active connection", async () => {
    await createRevisionProposal(companyId, employee.id, soulInput());
    let injected = false;
    const subscriber: EntitySubscriberInterface<AIEmployee> = {
      listenTo: () => AIEmployee,
      afterLoad: async () => {
        if (injected) return;
        injected = true;
        await recordAudit({
          companyId,
          action: "independent.completed",
          targetType: "routine",
          targetId: routine.id,
        });
      },
    };
    AppDataSource.subscribers.push(subscriber);
    try {
      await assert.rejects(
        createRevisionProposal(companyId, employee.id, soulInput()),
        /already pending/,
      );
    } finally {
      AppDataSource.subscribers.splice(AppDataSource.subscribers.indexOf(subscriber), 1);
    }
    assert.equal(injected, true);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "independent.completed" }),
      1,
    );
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 1);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 1);
  });
});

async function participant() {
  const colleague = await insert(AIEmployee, {
    role: "Reviewer",
    companyId,
    name: "Colleague",
    slug: randomUUID(),
    soulBody: "Keep changes reviewable.",
  });
  const receipt = await insert(RoutineChatMessage, {
    companyId,
    employeeId: colleague.id,
    routineId: routine.id,
    role: "assistant",
    status: "ok",
    content: "Helped investigate the report.",
  });
  return { colleague, receipt };
}
function sharedInput(evidenceRunIds: string[] = []) {
  return {
    kind: "routine_body" as const,
    targetId: routine.id,
    proposedBody: "Post the digest and cite every source.",
    rationale: "The digest omitted a source.",
    evidenceRunIds,
  };
}

describe("participating Routine revisions", () => {
  test("successful participants stage a brief change with exact target evidence and notify both managers", async () => {
    const { colleague } = await participant();
    const proposerManager = testId("proposer-manager");
    const targetManager = testId("target-manager");
    for (const userId of [proposerManager, targetManager])
      await insert(Membership, { companyId, userId, role: "member" });
    await AppDataSource.getRepository(AIEmployee).update(colleague.id, {
      reportsToUserId: proposerManager,
    });
    await AppDataSource.getRepository(AIEmployee).update(employee.id, {
      reportsToUserId: targetManager,
    });
    const evidence = await evidenceRun();
    const review = await reviewRun(colleague.id);
    const proposal = await createRevisionProposal(
      companyId,
      colleague.id,
      sharedInput([evidence.id]),
      { reviewRunId: review.id },
    );
    assert.equal(proposal.employeeId, colleague.id);
    assert.equal(proposal.targetLabel, `${routine.name} (${employee.name})`);
    assert.equal(proposal.baseBody, routine.body);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).body,
      routine.body,
    );
    const recipients = (
      await AppDataSource.getRepository(Notification).findBy({ kind: "revision_pending" })
    ).map((row) => row.userId);
    const companyOwner = await AppDataSource.getRepository(Membership).findOneByOrFail({
      companyId,
      role: "owner",
    });
    assert.deepEqual(
      new Set(recipients),
      new Set([companyOwner.userId, proposerManager, targetManager]),
    );
    await applyRevisionProposal(proposal, { userId: testId("owner"), note: "Include sources." });
    const changed = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(changed.body, proposal.proposedBody);
    assert.equal(changed.employeeId, employee.id);
    assert.equal(changed.acceptanceCriteria, routine.acceptanceCriteria);
    assert.deepEqual(
      new Set(
        (await AppDataSource.getRepository(JournalEntry).find()).map((row) => row.employeeId),
      ),
      new Set([employee.id, colleague.id]),
    );
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "revision.apply",
    });
    assert.match(audit.metadataJson, new RegExp(colleague.id));
    assert.match(audit.metadataJson, new RegExp(employee.id));
  });

  test("participants cannot use the receipt for another brief, a Skill, or acceptance criteria", async () => {
    const { colleague } = await participant();
    const unrelated = await insert(Routine, {
      employeeId: employee.id,
      name: "Unrelated",
      slug: randomUUID(),
      cronExpr: "0 9 * * 1",
      body: "Other work.",
    });
    for (const input of [
      { ...sharedInput(), targetId: unrelated.id },
      { ...sharedInput(), kind: "skill" as const, targetId: skill.id },
      { ...sharedInput(), kind: "routine_criteria" as const },
    ])
      await assert.rejects(createRevisionProposal(companyId, colleague.id, input), RevisionError);
    await AppDataSource.getRepository(RoutineChatMessage).update(
      { employeeId: colleague.id },
      { status: "working" },
    );
    await assert.rejects(
      createRevisionProposal(companyId, colleague.id, sharedInput()),
      /participation/,
    );
  });

  test("shared evidence must be finished work of this exact target or the proposer's own work", async () => {
    const { colleague } = await participant();
    const target = await evidenceRun({ outcomeVerdict: "unverified" });
    const ownRoutine = await insert(Routine, {
      employeeId: colleague.id,
      name: "Own report",
      slug: randomUUID(),
      cronExpr: "0 9 * * 1",
    });
    const own = await evidenceRun({ routineId: ownRoutine.id });
    const unrelated = await insert(Routine, {
      employeeId: employee.id,
      name: "Other report",
      slug: randomUUID(),
      cronExpr: "0 9 * * 1",
    });
    const invalid = [
      await evidenceRun({ routineId: unrelated.id }),
      await evidenceRun({ status: "running", finishedAt: null }),
      await evidenceRun({ status: "skipped" }),
    ];
    const selfReview = await reviewRun(colleague.id);
    invalid.push(await evidenceRun({ routineId: selfReview.routineId }));
    for (const run of invalid)
      await assert.rejects(
        createRevisionProposal(companyId, colleague.id, sharedInput([run.id])),
        /Evidence must/,
      );
    await assert.rejects(
      createRevisionProposal(companyId, colleague.id, soulInput([target.id])),
      /Evidence must/,
    );
    const proposal = await createRevisionProposal(
      companyId,
      colleague.id,
      sharedInput([own.id, target.id]),
    );
    assert.deepEqual(serializeRevisionProposal(proposal).evidenceRunIds, [own.id, target.id]);
  });

  test("clearing participation prevents create and apply but leaves an inert proposal rejectable", async () => {
    const { colleague, receipt } = await participant();
    const proposal = await createRevisionProposal(companyId, colleague.id, sharedInput());
    await AppDataSource.getRepository(RoutineChatMessage).delete(receipt.id);
    await assert.rejects(
      applyRevisionProposal(proposal, { userId: testId("owner") }),
      /participation/,
    );
    assert.equal((await getRevisionProposal(companyId, proposal.id))?.status, "pending");
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).body,
      routine.body,
    );
    await rejectRevisionProposal(proposal, {
      userId: testId("owner"),
      note: "Participation ended.",
    });
    await assert.rejects(
      createRevisionProposal(companyId, colleague.id, sharedInput()),
      /participation/,
    );
  });

  test("target deletion or transfer to a foreign company fails closed at apply", async () => {
    const { colleague } = await participant();
    const proposal = await createRevisionProposal(companyId, colleague.id, sharedInput());
    const foreign = await insert(AIEmployee, {
      role: "Reviewer",
      companyId: randomUUID(),
      name: "Foreign",
      slug: randomUUID(),
    });
    await AppDataSource.getRepository(Routine).update(routine.id, { employeeId: foreign.id });
    await assert.rejects(
      applyRevisionProposal(proposal, { userId: testId("owner") }),
      /participation/,
    );
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
    await AppDataSource.getRepository(Routine).delete(routine.id);
    await assert.rejects(applyRevisionProposal(proposal, { userId: testId("owner") }), /not yours/);
  });

  test("same-company reassignment uses the current owner and never transfers ownership back", async () => {
    const { colleague } = await participant();
    const proposal = await createRevisionProposal(companyId, colleague.id, sharedInput());
    const successor = await insert(AIEmployee, {
      role: "Reviewer",
      companyId,
      name: "Successor",
      slug: randomUUID(),
    });
    await AppDataSource.getRepository(Routine).update(routine.id, { employeeId: successor.id });
    await applyRevisionProposal(proposal, { userId: testId("owner") });
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).employeeId,
      successor.id,
    );
    assert.deepEqual(
      new Set(
        (await AppDataSource.getRepository(JournalEntry).find()).map((row) => row.employeeId),
      ),
      new Set([colleague.id, successor.id]),
    );
  });

  test("owner and different participants race for a single pending target and stale decisions are refused", async () => {
    const first = await participant();
    const second = await participant();
    const results = await Promise.allSettled(
      [employee.id, first.colleague.id, second.colleague.id].map((id) =>
        createRevisionProposal(companyId, id, sharedInput()),
      ),
    );
    assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 1);
    const proposal = await AppDataSource.getRepository(RevisionProposal).findOneByOrFail({
      status: "pending",
    });
    const decisions = await Promise.allSettled([
      applyRevisionProposal(proposal, { userId: testId("owner") }),
      rejectRevisionProposal(proposal, { userId: testId("owner") }),
    ]);
    assert.equal(decisions.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ targetId: proposal.id }),
      1,
    );
  });

  test("another participant cannot repeat the same rejected automatic suggestion without new evidence", async () => {
    const first = await participant();
    const second = await participant();
    const old = await evidenceRun();
    const priorReview = await reviewRun(first.colleague.id);
    const proposal = await createRevisionProposal(
      companyId,
      first.colleague.id,
      sharedInput([old.id]),
      { reviewRunId: priorReview.id },
    );
    await rejectAt(proposal, "2025-01-10T00:00:00Z");
    const review = await reviewRun(second.colleague.id);
    await assert.rejects(
      createRevisionProposal(companyId, second.colleague.id, sharedInput([old.id]), {
        reviewRunId: review.id,
      }),
      /new work finished after/,
    );
    const latest = await evidenceRun({ finishedAt: new Date("2025-01-11T00:00:00Z") });
    const retry = await createRevisionProposal(
      companyId,
      second.colleague.id,
      sharedInput([latest.id]),
      { reviewRunId: review.id },
    );
    assert.equal(retry.status, "pending");
    await assert.rejects(
      createRevisionProposal(companyId, second.colleague.id, soulInput(), {
        reviewRunId: review.id,
      }),
      /already created a proposal/,
    );
  });
});

test("concurrent distinct own revisions each persist their notification on SQLite", async () => {
  const employees: AIEmployee[] = [];
  for (let index = 0; index < 8; index++) {
    employees.push(
      await insert(AIEmployee, {
        companyId,
        name: `Reviewer ${index}`,
        slug: randomUUID(),
        role: "Reviewer",
        soulBody: "Cite sources.",
      }),
    );
  }
  const results = await Promise.allSettled(
    employees.map((colleague, index) =>
      createRevisionProposal(companyId, colleague.id, {
        kind: "soul",
        proposedBody: `Cite sources and include verification step ${index}.`,
        rationale: "The work needs a clear verification step.",
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, employees.length);
  const proposals = await AppDataSource.getRepository(RevisionProposal).findBy({ companyId });
  const notifications = await AppDataSource.getRepository(Notification).findBy({
    companyId,
    kind: "revision_pending",
  });
  assert.equal(proposals.length, employees.length);
  assert.equal(notifications.length, employees.length);
  assert.deepEqual(
    new Set(notifications.map((row) => row.entityId)),
    new Set(proposals.map((row) => row.id)),
  );
  assert.ok(notifications.every((row) => row.createdAt instanceof Date));
});
