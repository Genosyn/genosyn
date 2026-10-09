import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { DEFAULT_DECISION_STACK_INSTRUCTIONS } from "../../shared/decisionStackInstructions.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  DecisionStackSettingsError,
  canManageDecisionStack,
  decisionStackStateOf,
  getDecisionStackState,
  isDecisionStackEnabled,
  parseDecisionStackInstructions,
  readDecisionStackSettings,
  updateDecisionStackSettings,
} from "./decisionStackSettings.js";
import { registerResourceChangeSink } from "./resourceEvents.js";

/**
 * The Decision stack's company settings: on by default, null instructions
 * follow the default, owners and admins change them, Members only read them,
 * and a refused part of a change refuses all of it.
 */

before(initTestDb);
after(closeTestDb);

let company: Company;
let other: Company;

beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner-1" });
  other = await insert(Company, { name: "Globex", slug: "globex", ownerId: "owner-2" });
});

async function audits(companyId = company.id): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { companyId, action: "decision.stack.settings" },
    order: { createdAt: "ASC" },
  });
}

async function stored(companyId = company.id): Promise<Company> {
  return AppDataSource.getRepository(Company).findOneByOrFail({ id: companyId });
}

async function decision(companyId: string, status: Decision["status"]): Promise<Decision> {
  return insert(Decision, {
    companyId,
    employeeId: "emp-1",
    title: `A ${status} question`,
    body: "",
    optionsJson: JSON.stringify([{ id: "yes", label: "Yes", detail: null, tone: "neutral" }]),
    status,
    urgency: "normal",
  });
}

describe("defaults", () => {
  test("a new company takes new Decisions and follows the default instructions", async () => {
    const row = await stored();
    assert.equal(row.decisionStackEnabled, true);
    assert.equal(row.decisionStackInstructions, null);
    assert.deepEqual(await getDecisionStackState(company.id), {
      enabled: true,
      instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS,
      usingDefaultInstructions: true,
    });
    assert.equal(await isDecisionStackEnabled(company.id), true);
  });

  test("a partial row reads as a company created today", () => {
    assert.deepEqual(decisionStackStateOf({}), {
      enabled: true,
      instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS,
      usingDefaultInstructions: true,
    });
    assert.deepEqual(decisionStackStateOf({ decisionStackEnabled: false }), {
      enabled: false,
      instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS,
      usingDefaultInstructions: true,
    });
    assert.deepEqual(decisionStackStateOf({ decisionStackInstructions: "" }), {
      enabled: true,
      instructions: "",
      usingDefaultInstructions: false,
    });
  });

  test("an unknown company has no state and reads as on", async () => {
    assert.equal(await getDecisionStackState("00000000-0000-4000-8000-000000000000"), null);
    assert.equal(await isDecisionStackEnabled("00000000-0000-4000-8000-000000000000"), true);
  });
});

describe("who may change it", () => {
  test("owners and admins; never Members or nobody", () => {
    assert.equal(canManageDecisionStack("owner"), true);
    assert.equal(canManageDecisionStack("admin"), true);
    assert.equal(canManageDecisionStack("member"), false);
    assert.equal(canManageDecisionStack(undefined), false);
    assert.equal(canManageDecisionStack(null), false);
  });

  test("a Member is refused with a sentence, and nothing is written or audited", async () => {
    await assert.rejects(
      updateDecisionStackSettings({
        companyId: company.id,
        actorUserId: "member-1",
        actorRole: "member",
        input: { enabled: false, instructions: "Ask about everything." },
      }),
      (error: unknown) =>
        error instanceof DecisionStackSettingsError &&
        error.status === 403 &&
        error.message === "Only owners and admins can change the Decision stack settings.",
    );
    const row = await stored();
    assert.equal(row.decisionStackEnabled, true);
    assert.equal(row.decisionStackInstructions, null);
    assert.deepEqual(await audits(), []);
  });

  test("a missing role is refused like a Member", async () => {
    await assert.rejects(
      updateDecisionStackSettings({
        companyId: company.id,
        actorUserId: null,
        actorRole: undefined,
        input: { enabled: false },
      }),
      (error: unknown) => error instanceof DecisionStackSettingsError && error.status === 403,
    );
    assert.equal((await stored()).decisionStackEnabled, true);
  });

  for (const role of ["owner", "admin"] as const) {
    test(`an ${role} can switch it off and on again`, async () => {
      const off = await updateDecisionStackSettings({
        companyId: company.id,
        actorUserId: `${role}-1`,
        actorRole: role,
        input: { enabled: false },
      });
      assert.equal(off.enabled, false);
      assert.equal(off.canManage, true);
      assert.equal((await stored()).decisionStackEnabled, false);
      assert.equal(await isDecisionStackEnabled(company.id), false);

      const on = await updateDecisionStackSettings({
        companyId: company.id,
        actorUserId: `${role}-1`,
        actorRole: role,
        input: { enabled: true },
      });
      assert.equal(on.enabled, true);
      assert.equal(await isDecisionStackEnabled(company.id), true);
    });
  }
});

describe("instructions", () => {
  const admin = (input: { enabled?: boolean; instructions?: string | null }) =>
    updateDecisionStackSettings({
      companyId: company.id,
      actorUserId: "admin-1",
      actorRole: "admin",
      input,
    });

  test("null and the default typed out both mean the default", () => {
    assert.equal(parseDecisionStackInstructions(null), null);
    assert.equal(parseDecisionStackInstructions(DEFAULT_DECISION_STACK_INSTRUCTIONS), null);
    assert.equal(
      parseDecisionStackInstructions(
        `\n${DEFAULT_DECISION_STACK_INSTRUCTIONS.replace(/\n/g, "\r\n")}  \n\n`,
      ),
      null,
    );
  });

  test("an emptied box is stored as a deliberate no-instructions", () => {
    assert.equal(parseDecisionStackInstructions(""), "");
    assert.equal(parseDecisionStackInstructions("  \n\t\n"), "");
  });

  test("the company's own text is stored tidied", () => {
    assert.equal(
      parseDecisionStackInstructions("Only ask about contracts.   \r\nNever about labels.\n\n"),
      "Only ask about contracts.\nNever about labels.",
    );
  });

  test("too long, too many lines, or unprintable text is refused with the box's sentence", () => {
    const refusals: Array<[string, string]> = [
      ["a".repeat(4_001), "Keep the instructions under 4,000 characters."],
      [
        Array.from({ length: 31 }, (_, index) => `Rule ${index + 1}`).join("\n"),
        "Keep it to 30 instructions or fewer, one per line.",
      ],
      ["Ask\u0000 me", "Instructions can only contain printable characters."],
    ];
    for (const [text, message] of refusals) {
      assert.throws(
        () => parseDecisionStackInstructions(text),
        (error: unknown) =>
          error instanceof DecisionStackSettingsError &&
          error.status === 400 &&
          error.message === message,
      );
    }
  });

  test("save, read back, clear and restore round-trip through the row", async () => {
    const saved = await admin({ instructions: "Only ask about money.\nNever ask about wording." });
    assert.equal(saved.instructions, "Only ask about money.\nNever ask about wording.");
    assert.equal(saved.usingDefaultInstructions, false);
    assert.equal((await stored()).decisionStackInstructions, saved.instructions);
    assert.deepEqual(await readDecisionStackSettings(company.id, "member"), {
      enabled: true,
      instructions: saved.instructions,
      usingDefaultInstructions: false,
      pendingDecisions: 0,
      canManage: false,
    });

    const cleared = await admin({ instructions: "" });
    assert.equal(cleared.instructions, "");
    assert.equal(cleared.usingDefaultInstructions, false);
    assert.equal((await stored()).decisionStackInstructions, "");

    const restored = await admin({ instructions: null });
    assert.equal(restored.instructions, DEFAULT_DECISION_STACK_INSTRUCTIONS);
    assert.equal(restored.usingDefaultInstructions, true);
    assert.equal((await stored()).decisionStackInstructions, null);
  });

  test("saving the default word for word keeps following the default", async () => {
    await admin({ instructions: "Something of our own." });
    const back = await admin({ instructions: `${DEFAULT_DECISION_STACK_INSTRUCTIONS}\n` });
    assert.equal(back.usingDefaultInstructions, true);
    assert.equal((await stored()).decisionStackInstructions, null);
  });

  test("a refused part refuses the whole change: the switch is not flipped either", async () => {
    await assert.rejects(
      admin({ enabled: false, instructions: "a".repeat(4_001) }),
      DecisionStackSettingsError,
    );
    const row = await stored();
    assert.equal(row.decisionStackEnabled, true);
    assert.equal(row.decisionStackInstructions, null);
    assert.deepEqual(await audits(), []);
  });

  test("switching the stack leaves the instructions alone, and the other way round", async () => {
    await admin({ instructions: "Ask about contracts." });
    await admin({ enabled: false });
    assert.equal((await stored()).decisionStackInstructions, "Ask about contracts.");
    await admin({ instructions: "Ask about money." });
    assert.equal((await stored()).decisionStackEnabled, false);
  });

  test("instructions can be prepared while the stack is off", async () => {
    await admin({ enabled: false });
    const view = await admin({ instructions: "Ask only about hiring." });
    assert.equal(view.enabled, false);
    assert.equal(view.instructions, "Ask only about hiring.");
  });
});

describe("the write", () => {
  test("touches only its own columns, so a concurrent profile edit survives", async () => {
    // Another request renames the company after this one loaded its row.
    await AppDataSource.getRepository(Company).update(
      { id: company.id },
      { name: "Acme Holdings", mission: "Make widgets" },
    );
    await updateDecisionStackSettings({
      companyId: company.id,
      actorUserId: "admin-1",
      actorRole: "admin",
      input: { enabled: false, instructions: "Ask about contracts." },
    });
    const row = await stored();
    assert.equal(row.name, "Acme Holdings");
    assert.equal(row.mission, "Make widgets");
    assert.equal(row.decisionStackEnabled, false);
  });

  test("is scoped to its company", async () => {
    await updateDecisionStackSettings({
      companyId: company.id,
      actorUserId: "admin-1",
      actorRole: "admin",
      input: { enabled: false, instructions: "Ask about contracts." },
    });
    const untouched = await stored(other.id);
    assert.equal(untouched.decisionStackEnabled, true);
    assert.equal(untouched.decisionStackInstructions, null);
    assert.deepEqual(await audits(other.id), []);
  });

  test("an unknown company is a 404, not a silent no-op", async () => {
    await assert.rejects(
      updateDecisionStackSettings({
        companyId: "00000000-0000-4000-8000-000000000000",
        actorUserId: "admin-1",
        actorRole: "admin",
        input: { enabled: false },
      }),
      (error: unknown) => error instanceof DecisionStackSettingsError && error.status === 404,
    );
    await assert.rejects(
      readDecisionStackSettings("00000000-0000-4000-8000-000000000000", "admin"),
      (error: unknown) => error instanceof DecisionStackSettingsError && error.status === 404,
    );
  });

  test("records who changed what, word for word when the instructions changed", async () => {
    await updateDecisionStackSettings({
      companyId: company.id,
      actorUserId: "admin-1",
      actorRole: "admin",
      input: { enabled: false },
    });
    await updateDecisionStackSettings({
      companyId: company.id,
      actorUserId: "owner-1",
      actorRole: "owner",
      input: { instructions: "Ask about contracts." },
    });
    await updateDecisionStackSettings({
      companyId: company.id,
      actorUserId: "owner-1",
      actorRole: "owner",
      input: { instructions: null },
    });
    const rows = await audits();
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => ({
        actor: row.actorUserId,
        kind: row.actorKind,
        target: [row.targetType, row.targetId, row.targetLabel],
        metadata: JSON.parse(row.metadataJson),
      })),
      [
        {
          actor: "admin-1",
          kind: "user",
          target: ["company", company.id, "Acme"],
          metadata: { enabled: false, enabledChanged: true },
        },
        {
          actor: "owner-1",
          kind: "user",
          target: ["company", company.id, "Acme"],
          metadata: {
            enabled: false,
            instructionsDefault: false,
            instructions: "Ask about contracts.",
          },
        },
        {
          actor: "owner-1",
          kind: "user",
          target: ["company", company.id, "Acme"],
          metadata: {
            enabled: false,
            instructionsDefault: true,
            instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS,
          },
        },
      ],
    );
  });

  test("tells open Decision stack pages to refresh", async () => {
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((companyId, kind) => events.push({ companyId, kind }));
    try {
      await updateDecisionStackSettings({
        companyId: company.id,
        actorUserId: "admin-1",
        actorRole: "admin",
        input: { enabled: false },
      });
      // The sink flushes on a short timer.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.ok(
        events.some((event) => event.companyId === company.id && event.kind === "decision"),
        JSON.stringify(events),
      );
    } finally {
      registerResourceChangeSink(() => undefined);
    }
  });
});

describe("reading", () => {
  test("counts only this company's waiting Decisions", async () => {
    await decision(company.id, "pending");
    await decision(company.id, "pending");
    await decision(company.id, "decided");
    await decision(company.id, "cancelled");
    await decision(other.id, "pending");
    const view = await readDecisionStackSettings(company.id, "admin");
    assert.equal(view.pendingDecisions, 2);
    assert.equal(view.canManage, true);
    assert.equal((await readDecisionStackSettings(other.id, "owner")).pendingDecisions, 1);
  });

  test("tells a Member they can read but not change", async () => {
    const view = await readDecisionStackSettings(company.id, "member");
    assert.equal(view.canManage, false);
    assert.equal(view.enabled, true);
    assert.equal(view.instructions, DEFAULT_DECISION_STACK_INSTRUCTIONS);
  });

  test("an employee fixture is not mistaken for a company", async () => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Rey",
      slug: "rey",
      role: "Support",
      soulBody: "",
    });
    assert.equal(await getDecisionStackState(employee.id), null);
  });
});
