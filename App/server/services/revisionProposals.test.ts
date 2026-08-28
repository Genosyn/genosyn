import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  RevisionError,
  applyRevisionProposal,
  createRevisionProposal,
  getRevisionProposal,
  rejectRevisionProposal,
  serializeRevisionProposal,
} from "./revisionProposals.js";

/**
 * The maker-checker invariants: an employee proposes only against its own
 * surfaces, nothing changes until a human applies, and apply refuses when the
 * target drifted — the reviewer approved a diff, not a blind overwrite.
 */

let companyId: string;
let employee: AIEmployee;
let skill: Skill;
let routine: Routine;

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
    const runId = "3b241101-e2bb-4255-8caf-4136c566a962";
    const proposal = await createRevisionProposal(companyId, employee.id, {
      kind: "soul",
      proposedBody: "Be direct. Be brief.",
      rationale: "r",
      evidenceRunIds: [runId, "not-a-uuid"],
    });
    const dto = serializeRevisionProposal(proposal);
    assert.deepEqual(dto.evidenceRunIds, [runId]);
    proposal.evidenceRunIdsJson = "{broken";
    assert.deepEqual(serializeRevisionProposal(proposal).evidenceRunIds, []);
  });
});
