import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import { createDecision } from "./decisions.js";
import {
  ROUTED_DECISION_FUSE_MS,
  decideDecisionAsEmployee,
  resolveDecider,
  sweepRoutedDecisions,
} from "./decisionRouting.js";

/**
 * Decision routing's guarantees: human-only stays the default, a named human
 * assignee always wins, the skipped bell is always eventually sent (decline
 * and fuse), and only the routed decider may answer — recorded exactly like a
 * human answer, minus nothing.
 *
 * Every rule names its decider. A `manager` rule — "the asker's manager", from
 * the removed reporting lines — can still exist in an upgraded database; it
 * must match, route nowhere, and never let a later rule route its askers.
 */

let companyId: string;
let asker: AIEmployee;
let decider: AIEmployee;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  // `notifyDecisionPending` resolves the Company for its link; without the
  // row the bell silently no-ops, which is exactly what these tests assert
  // against.
  await insert(Company, {
    id: companyId,
    name: "Acme",
    slug: `acme-${companyId.slice(3, 11)}`,
    ownerId: testId("founder"),
  });
  decider = await insert(AIEmployee, {
    companyId,
    name: "Meredith",
    slug: "meredith",
    role: "Head of Ops",
    soulBody: "",
  });
  asker = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  await insert(AIModel, {
    employeeId: decider.id,
    provider: "anthropic",
    model: "claude-x",
    isActive: true,
  });
  await insert(Membership, { companyId, userId: testId("owner"), role: "owner" });
});

/** A rule naming `decider` for any asker, unless overridden. */
async function addRule(over: Partial<DecisionPolicy> = {}): Promise<DecisionPolicy> {
  return insert(DecisionPolicy, {
    companyId,
    askingEmployeeId: null,
    deciderKind: "employee",
    deciderEmployeeId: decider.id,
    sortOrder: 0,
    enabled: true,
    ...over,
  });
}

/**
 * A rule as an upgraded database still holds it: saved as "their manager"
 * before reporting lines were removed, so it names nobody. Written straight to
 * the table — no route can create one any more.
 */
function addRetiredManagerRule(over: Partial<DecisionPolicy> = {}): Promise<DecisionPolicy> {
  return addRule({ deciderKind: "manager", deciderEmployeeId: null, ...over });
}

async function connectModel(employee: AIEmployee): Promise<void> {
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-x",
    isActive: true,
  });
}

async function ask(over: { assigneeUserId?: string | null } = {}) {
  const { decision } = await createDecision({
    companyId,
    employeeId: asker.id,
    title: "Ship the pricing change?",
    options: [{ label: "Ship it" }, { label: "Hold" }],
    assigneeUserId: over.assigneeUserId ?? null,
  });
  return AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id });
}

function bells(): Promise<Notification[]> {
  return AppDataSource.getRepository(Notification).findBy({ kind: "decision_pending" });
}

describe("resolveDecider", () => {
  test("no enabled rule means no routing — human-only is the default", async () => {
    assert.equal(await resolveDecider(companyId, asker.id), null);
    await addRule({ enabled: false });
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("a named-employee rule routes to the employee it names", async () => {
    await addRule();
    const resolved = await resolveDecider(companyId, asker.id);
    assert.equal(resolved?.id, decider.id);
  });

  test("a rule for one asker routes only that asker", async () => {
    const other = await insert(AIEmployee, {
      companyId,
      name: "Bo",
      slug: "bo",
      role: "Writer",
      soulBody: "",
    });
    await addRule({ askingEmployeeId: asker.id });
    assert.equal((await resolveDecider(companyId, asker.id))?.id, decider.id);
    assert.equal(await resolveDecider(companyId, other.id), null);
  });

  test("another company's rules never route this company's questions", async () => {
    await addRule({ companyId: testCompanyId() });
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("a rule naming an employee of another company cannot serve", async () => {
    const stranger = await insert(AIEmployee, {
      companyId: testCompanyId(),
      name: "Eve",
      slug: "eve",
      role: "Spy",
      soulBody: "",
    });
    await connectModel(stranger);
    await addRule({ deciderEmployeeId: stranger.id });
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("a decider with no AI Model connected cannot serve", async () => {
    await AppDataSource.getRepository(AIModel).delete({ employeeId: decider.id });
    await addRule();
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("an employee never answers its own questions", async () => {
    await addRule({ deciderKind: "employee", deciderEmployeeId: asker.id });
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("the first matching enabled rule wins by sortOrder", async () => {
    const other = await insert(AIEmployee, {
      companyId,
      name: "Zed",
      slug: "zed",
      role: "CFO",
      soulBody: "",
    });
    await connectModel(other);
    await addRule({ deciderEmployeeId: other.id, sortOrder: 1 });
    await addRule({ sortOrder: 0 }); // names `decider`, lower sortOrder
    assert.equal((await resolveDecider(companyId, asker.id))?.id, decider.id);
  });
});

describe("a retired manager rule", () => {
  let zed: AIEmployee;

  beforeEach(async () => {
    zed = await insert(AIEmployee, {
      companyId,
      name: "Zed",
      slug: "zed",
      role: "CFO",
      soulBody: "",
    });
    await connectModel(zed);
  });

  test("matches but routes nowhere: the question stays with people", async () => {
    await addRetiredManagerRule();
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("first in line, it keeps a later named rule from routing its askers", async () => {
    await addRetiredManagerRule({ sortOrder: 0 });
    await addRule({ deciderEmployeeId: zed.id, sortOrder: 1 });
    assert.equal(
      await resolveDecider(companyId, asker.id),
      null,
      "dropping it must not hand the question to a decider nobody picked for this asker",
    );
  });

  test("scoped to one asker, it leaves every other asker to the later rules", async () => {
    const bo = await insert(AIEmployee, {
      companyId,
      name: "Bo",
      slug: "bo",
      role: "Writer",
      soulBody: "",
    });
    await addRetiredManagerRule({ askingEmployeeId: asker.id, sortOrder: 0 });
    await addRule({ deciderEmployeeId: zed.id, sortOrder: 1 });
    assert.equal(await resolveDecider(companyId, asker.id), null);
    assert.equal((await resolveDecider(companyId, bo.id))?.id, zed.id);
  });

  test("behind a named rule, it changes nothing: the named rule routes", async () => {
    await addRule({ deciderEmployeeId: zed.id, sortOrder: 0 });
    await addRetiredManagerRule({ sortOrder: 1 });
    assert.equal((await resolveDecider(companyId, asker.id))?.id, zed.id);
  });

  test("disabled, it no longer matches, like any disabled rule", async () => {
    await addRetiredManagerRule({ sortOrder: 0, enabled: false });
    await addRule({ deciderEmployeeId: zed.id, sortOrder: 1 });
    assert.equal((await resolveDecider(companyId, asker.id))?.id, zed.id);
  });

  test("ignores a decider left on the row: only a named-employee rule routes", async () => {
    // Not a shape the API can write, but a hand-edited row must still fail safe.
    await addRetiredManagerRule({ deciderEmployeeId: zed.id });
    assert.equal(await resolveDecider(companyId, asker.id), null);
  });

  test("a new question is not routed and rings the human bell exactly once", async () => {
    await addRetiredManagerRule();
    const decision = await ask();
    assert.equal(decision.routedToEmployeeId, null);
    assert.equal(decision.routedAt, null);
    assert.equal((await bells()).length, 1);
  });
});

describe("routing at creation", () => {
  test("a routed decision skips the human bell and records where it went", async () => {
    await addRule();
    const decision = await ask();
    assert.equal(decision.routedToEmployeeId, decider.id);
    assert.ok(decision.routedAt);
    assert.equal((await bells()).length, 0);
  });

  test("with no rule the human bell fires exactly as before", async () => {
    const decision = await ask();
    assert.equal(decision.routedToEmployeeId, null);
    assert.equal((await bells()).length, 1);
  });

  test("a named human assignee always wins over any rule", async () => {
    await addRule();
    const decision = await ask({ assigneeUserId: testId("owner") });
    assert.equal(decision.routedToEmployeeId, null);
  });
});

describe("decideDecisionAsEmployee", () => {
  test("only the routed decider may answer, and the answer is recorded as an AI answer", async () => {
    await addRule();
    const decision = await ask();
    const optionId = JSON.parse(decision.optionsJson)[0].id as string;

    const stranger = await decideDecisionAsEmployee({
      companyId,
      decisionId: decision.id,
      deciderEmployeeId: asker.id,
      optionId,
    });
    assert.equal(stranger.outcome, "forbidden");

    const result = await decideDecisionAsEmployee({
      companyId,
      decisionId: decision.id,
      deciderEmployeeId: decider.id,
      optionId,
      note: "Revenue impact is small and reversible.",
    });
    assert.equal(result.outcome, "decided");
    const fresh = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: decision.id,
    });
    assert.equal(fresh.status, "decided");
    assert.equal(fresh.decidedByEmployeeId, decider.id);
    assert.equal(fresh.decidedByUserId, null);
    assert.equal(fresh.chosenOptionLabel, "Ship it");
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({
      employeeId: asker.id,
    });
    assert.ok(journal.some((j) => /Meredith decided/.test(j.title)));
  });

  test("a second answer is a conflict, not a rewrite", async () => {
    await addRule();
    const decision = await ask();
    const optionId = JSON.parse(decision.optionsJson)[0].id as string;
    await decideDecisionAsEmployee({
      companyId,
      decisionId: decision.id,
      deciderEmployeeId: decider.id,
      optionId,
    });
    const second = await decideDecisionAsEmployee({
      companyId,
      decisionId: decision.id,
      deciderEmployeeId: decider.id,
      optionId,
    });
    assert.equal(second.outcome, "conflict");
  });

  test("an unknown option is refused by id, not guessed", async () => {
    await addRule();
    const decision = await ask();
    const result = await decideDecisionAsEmployee({
      companyId,
      decisionId: decision.id,
      deciderEmployeeId: decider.id,
      optionId: "nope",
    });
    assert.equal(result.outcome, "unknown_option");
  });

  test("declining un-routes and sends exactly the bell the routing skipped", async () => {
    await addRule();
    const decision = await ask();
    assert.equal((await bells()).length, 0);
    const result = await decideDecisionAsEmployee({
      companyId,
      decisionId: decision.id,
      deciderEmployeeId: decider.id,
      declineReason: "This is a money call; a human should make it.",
    });
    assert.equal(result.outcome, "declined");
    const fresh = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: decision.id,
    });
    assert.equal(fresh.status, "pending");
    assert.equal(fresh.routedToEmployeeId, null);
    assert.equal((await bells()).length, 1);
  });
});

describe("the fallback fuse", () => {
  test("a routed decision held past the fuse falls back to humans exactly once", async () => {
    await addRule();
    const decision = await ask();
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      { routedAt: new Date(Date.now() - ROUTED_DECISION_FUSE_MS - 60_000) },
    );
    await sweepRoutedDecisions();
    await sweepRoutedDecisions();
    const fresh = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: decision.id,
    });
    assert.equal(fresh.status, "pending");
    assert.equal(fresh.routedToEmployeeId, null);
    assert.equal((await bells()).length, 1);
  });

  test("a freshly routed decision is left alone", async () => {
    await addRule();
    const decision = await ask();
    await sweepRoutedDecisions();
    const fresh = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: decision.id,
    });
    assert.equal(fresh.routedToEmployeeId, decider.id);
    assert.equal((await bells()).length, 0);
  });
});
