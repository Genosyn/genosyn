import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import { BoardLetterSettings } from "../db/entities/BoardLetterSettings.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { runRestrictedEmployeeAgent } from "./agent/runEmployee.js";
import { deliverBoardLetter } from "./boardLetterNotice.js";
import {
  auditBoardLetterAgain,
  BoardLetterConflictError,
  BoardLetterNotFoundError,
  BoardLetterValidationError,
  type BoardLetterDependencies,
  detachEmployeeFromBoardLetters,
  dispatchDueBoardLetters,
  getBoardLetter,
  getBoardLetterSettings,
  listBoardLetters,
  MAX_SCHEDULED_ATTEMPTS,
  reconcileStaleBoardLetters,
  updateBoardLetterSettings,
  writeBoardLetterNow,
} from "./boardLetters.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  stopStanddowns();
});
afterEach(() => stopStanddowns());

type RestrictedParams = Parameters<typeof runRestrictedEmployeeAgent>[0];
type RestrictedResult = Awaited<ReturnType<typeof runRestrictedEmployeeAgent>>;

type Fixture = {
  company: Company;
  owner: User;
  admin: User;
  member: User;
  writer: AIEmployee;
  auditor: AIEmployee;
  bystander: AIEmployee;
};

const LETTER = {
  summary: "We are on track for the Goal, with one failure owned.",
  body: "We finished 2 Runs this month and 1 of them failed.\n\nThe failure is being looked into.",
};
const CLEAN = { opinion: "clean", note: "The letter is accurate and complete.", findings: [] };

async function fixture(): Promise<Fixture> {
  const owner = await insert(User, {
    email: "owner@sunwise.test",
    name: "Olive Owner",
    passwordHash: "x",
  });
  const admin = await insert(User, {
    email: "admin@sunwise.test",
    name: "Adam Admin",
    passwordHash: "x",
  });
  const member = await insert(User, {
    email: "member@sunwise.test",
    name: "Mel Member",
    passwordHash: "x",
  });
  const company = await insert(Company, {
    name: "Sunwise",
    slug: "sunwise",
    ownerId: owner.id,
    timezone: "UTC",
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  const employee = async (name: string, connected: boolean) => {
    const row = await insert(AIEmployee, {
      companyId: company.id,
      name,
      slug: name.toLowerCase(),
      role: `${name}'s role`,
      soulBody: `${name} tells the truth.`,
    });
    if (connected) {
      await insert(AIModel, {
        employeeId: row.id,
        provider: "openai",
        model: "gpt-test",
        authMode: "apikey",
        isActive: true,
        configJson: JSON.stringify({ apiKeyEncrypted: "ciphertext" }),
        connectedAt: new Date("2026-01-01T00:00:00Z"),
        contextWindow: null,
        contextWindowSource: null,
      });
    }
    return row;
  };
  const writer = await employee("Ada", true);
  const auditor = await employee("Otto", true);
  const bystander = await employee("Juno", false);
  const routine = await insert(Routine, {
    employeeId: writer.id,
    name: "Install roofs",
    slug: "install-roofs",
    cronExpr: "0 * * * *",
    body: "",
  });
  for (const [status, at] of [
    ["completed", "2026-09-03T10:00:00Z"],
    ["failed", "2026-09-04T10:00:00Z"],
  ] as const) {
    await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(at),
      finishedAt: new Date(at),
      status,
      logContent: "",
    });
  }
  return { company, owner, admin, member, writer, auditor, bystander };
}

type Plan = Record<string, unknown> | "error" | "nothing";

/**
 * The model, scripted: the writer submits `letter`, the auditor submits
 * `audit`, and every turn is recorded with the one tool it was given.
 */
function model(script: { letter?: Plan; audit?: Plan } = {}) {
  const calls: Array<{
    tool: string;
    tools: string[];
    employeeId: string;
    system: string;
    prompt: string;
    maxSteps: number;
  }> = [];
  const runRestricted = async (params: RestrictedParams): Promise<RestrictedResult> => {
    const [tool] = params.tools;
    const prompt = JSON.stringify(params.messages);
    calls.push({
      tool: tool.name,
      tools: params.tools.map((item) => item.name),
      employeeId: params.employeeId,
      system: params.system,
      prompt,
      maxSteps: params.maxSteps,
    });
    const plan =
      tool.name === "submit_board_letter" ? (script.letter ?? LETTER) : (script.audit ?? CLEAN);
    if (plan === "error") return { status: "error", error: "The provider is down." };
    if (plan !== "nothing") await tool.run(plan);
    return { status: "ok", finalText: "", steps: 1 };
  };
  return { calls, runRestricted };
}

function deps(
  now: Date,
  runRestricted: BoardLetterDependencies["runRestricted"],
  delivered: string[] = [],
): BoardLetterDependencies {
  return {
    now: () => now,
    runRestricted,
    deliver: async (id) => {
      delivered.push(id);
      return true;
    },
  };
}

async function letters(companyId: string): Promise<BoardLetter[]> {
  return AppDataSource.getRepository(BoardLetter).find({
    where: { companyId },
    order: { number: "ASC" },
  });
}

async function settingsRow(companyId: string): Promise<BoardLetterSettings> {
  const row = await AppDataSource.getRepository(BoardLetterSettings).findOneBy({ companyId });
  assert.ok(row, "no settings row");
  return row;
}

async function enable(
  f: Fixture,
  at: Date,
  options: { auditor?: boolean; writer?: AIEmployee } = {},
) {
  return updateBoardLetterSettings(
    f.company.id,
    {
      enabled: true,
      writerEmployeeId: (options.writer ?? f.writer).id,
      auditorEmployeeId: options.auditor === false ? null : f.auditor.id,
    },
    f.owner.id,
    at,
  );
}

async function settle(result: { completions: Array<Promise<unknown>> }): Promise<void> {
  await Promise.all(result.completions);
}

describe("choosing the writer and appointing the auditor", () => {
  test("records who appointed the auditor, and when", async () => {
    const f = await fixture();
    const at = new Date("2026-09-10T09:00:00Z");
    const saved = await enable(f, at);
    assert.equal(saved.enabled, true);
    assert.equal(saved.writer?.name, "Ada");
    assert.equal(saved.auditor?.name, "Otto");
    assert.deepEqual(saved.auditorAppointedBy, { id: f.owner.id, name: "Olive Owner" });
    assert.equal(saved.auditorAppointedAt, at.toISOString());
    assert.equal(saved.enabledAt, at.toISOString());

    const events = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: f.company.id },
      order: { createdAt: "ASC" },
    });
    const appointed = events.find((event) => event.action === "board_letter.auditor.appoint");
    assert.ok(appointed, "the appointment is in the audit log");
    assert.equal(appointed.actorUserId, f.owner.id);
    assert.equal(appointed.targetId, f.auditor.id);
    assert.ok(events.some((event) => event.action === "board_letter.settings.update"));
  });

  test("never lets the writer audit its own letter", async () => {
    const f = await fixture();
    await assert.rejects(
      updateBoardLetterSettings(
        f.company.id,
        { enabled: true, writerEmployeeId: f.writer.id, auditorEmployeeId: f.writer.id },
        f.owner.id,
      ),
      (error: unknown) =>
        error instanceof BoardLetterValidationError && /other than the writer/.test(error.message),
    );
  });

  test("needs a writer before letters can be switched on", async () => {
    const f = await fixture();
    await assert.rejects(
      updateBoardLetterSettings(
        f.company.id,
        { enabled: true, writerEmployeeId: null, auditorEmployeeId: f.auditor.id },
        f.owner.id,
      ),
      BoardLetterValidationError,
    );
  });

  test("accepts only AI Employees of this company", async () => {
    const f = await fixture();
    const elsewhere = await insert(Company, { name: "Other", slug: "other", ownerId: f.owner.id });
    const stranger = await insert(AIEmployee, {
      companyId: elsewhere.id,
      name: "Stranger",
      slug: "stranger",
      role: "Spy",
      soulBody: "",
    });
    for (const input of [
      { enabled: false, writerEmployeeId: stranger.id, auditorEmployeeId: null },
      { enabled: false, writerEmployeeId: f.writer.id, auditorEmployeeId: stranger.id },
    ]) {
      await assert.rejects(
        updateBoardLetterSettings(f.company.id, input, f.owner.id),
        BoardLetterValidationError,
      );
    }
  });

  test("keeps an appointment until the auditor itself changes", async () => {
    const f = await fixture();
    const first = new Date("2026-09-10T09:00:00Z");
    await enable(f, first);
    // Changing only the writer leaves the auditor's appointment as it was.
    const writerChanged = await updateBoardLetterSettings(
      f.company.id,
      { enabled: true, writerEmployeeId: f.bystander.id, auditorEmployeeId: f.auditor.id },
      f.admin.id,
      new Date("2026-09-11T09:00:00Z"),
    );
    assert.equal(writerChanged.auditorAppointedAt, first.toISOString());
    assert.equal(writerChanged.auditorAppointedBy?.id, f.owner.id);
    // Removing the auditor ends the appointment and says so in the audit log.
    const removed = await updateBoardLetterSettings(
      f.company.id,
      { enabled: true, writerEmployeeId: f.writer.id, auditorEmployeeId: null },
      f.admin.id,
      new Date("2026-09-12T09:00:00Z"),
    );
    assert.equal(removed.auditor, null);
    assert.equal(removed.auditorAppointedBy, null);
    const removal = await AppDataSource.getRepository(AuditEvent).findOneBy({
      companyId: f.company.id,
      action: "board_letter.auditor.remove",
    });
    assert.equal(removal?.actorUserId, f.admin.id);
  });

  test("owes no letter for a month that ended before letters were switched on", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    const saved = await enable(f, at);
    // September ended before letters were on: a person may ask for it, the
    // schedule does not owe it. October's is due at 06:00 on November 1.
    assert.deepEqual(saved.lastMonth, {
      month: "2026-09",
      label: "September 2026",
      letterNumber: null,
      status: null,
      canWrite: true,
    });
    assert.deepEqual(saved.nextLetter, {
      month: "2026-10",
      label: "October 2026",
      dueAt: "2026-11-01T06:00:00.000Z",
    });
    const result = await dispatchDueBoardLetters(
      new Date("2026-10-21T09:00:00Z"),
      deps(at, model().runRestricted),
    );
    assert.equal(result.started, 0);
    assert.equal((await letters(f.company.id)).length, 0);
  });

  test("says why letters are waiting", async () => {
    const f = await fixture();
    const noModel = await enable(f, new Date("2026-10-20T09:00:00Z"), { writer: f.bystander });
    assert.match(noModel.waiting ?? "", /Juno needs a connected AI Model/);
    assert.equal(noModel.lastMonth.canWrite, true);

    await enable(f, new Date("2026-10-20T09:00:00Z"));
    await placeStanddown({
      companyId: f.company.id,
      scope: "employee",
      scopeId: f.writer.id,
      reason: "Checking the books",
      placedByUserId: f.owner.id,
    });
    const stood = await getBoardLetterSettings(f.company.id, new Date("2026-10-20T10:00:00Z"));
    assert.match(stood.waiting ?? "", /Ada is stood down/);
    assert.equal(stood.lastMonth.canWrite, false);
  });
});

describe("the schedule", () => {
  test("writes the month's letter at 06:00 on the first, exactly once", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { calls, runRestricted } = model();
    const delivered: string[] = [];

    const early = await dispatchDueBoardLetters(
      new Date("2026-10-01T05:59:00Z"),
      deps(new Date("2026-10-01T05:59:00Z"), runRestricted, delivered),
    );
    assert.equal(early.started, 0);

    const due = new Date("2026-10-01T06:00:00Z");
    const [one, two] = await Promise.all([
      dispatchDueBoardLetters(due, deps(due, runRestricted, delivered)),
      dispatchDueBoardLetters(due, deps(due, runRestricted, delivered)),
    ]);
    assert.equal(one.started + two.started, 1);
    await settle(one);
    await settle(two);

    const [letter] = await letters(f.company.id);
    assert.equal(letter.number, 1);
    assert.equal(letter.month, "2026-09");
    assert.equal(letter.status, "ready");
    assert.equal(letter.triggerKind, "schedule");
    assert.equal(letter.auditStatus, "clean");
    assert.equal(letter.writerName, "Ada");
    assert.equal(letter.auditorName, "Otto");
    assert.equal(letter.body, LETTER.body);
    assert.deepEqual(delivered, [letter.id]);
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["submit_board_letter", "submit_audit"],
    );

    const later = new Date("2026-10-01T06:30:00Z");
    const again = await dispatchDueBoardLetters(later, deps(later, runRestricted, delivered));
    assert.equal(again.started, 0);
    assert.equal(
      (await settingsRow(f.company.id)).nextLetterAt?.toISOString(),
      "2026-11-01T06:00:00.000Z",
    );
  });

  test("numbers the letters in order, one a month", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { runRestricted } = model();
    for (const at of ["2026-10-01T06:00:00Z", "2026-11-01T06:00:00Z", "2026-12-01T06:00:00Z"]) {
      const now = new Date(at);
      await settle(await dispatchDueBoardLetters(now, deps(now, runRestricted)));
    }
    assert.deepEqual(
      (await letters(f.company.id)).map((letter) => [letter.number, letter.month]),
      [
        [1, "2026-09"],
        [2, "2026-10"],
        [3, "2026-11"],
      ],
    );
  });

  test("waits out a Standdown on the writer, then writes the letter", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const standdown = await placeStanddown({
      companyId: f.company.id,
      scope: "employee",
      scopeId: f.writer.id,
      reason: "Checking the books",
      placedByUserId: f.owner.id,
    });
    const { calls, runRestricted } = model();
    const due = new Date("2026-10-01T06:00:00Z");
    const held = await dispatchDueBoardLetters(due, deps(due, runRestricted));
    assert.equal(held.started, 0);
    assert.equal(calls.length, 0, "no model turn while the writer is stood down");
    const waiting = await settingsRow(f.company.id);
    assert.match(waiting.lastError, /stood down/);
    assert.equal(waiting.nextLetterAt?.toISOString(), "2026-10-01T06:10:00.000Z");

    await liftStanddown({ standdown, userId: f.owner.id, reason: "Books are fine" });
    const after = new Date("2026-10-01T06:10:00Z");
    await settle(await dispatchDueBoardLetters(after, deps(after, runRestricted)));
    const [letter] = await letters(f.company.id);
    assert.equal(letter.status, "ready");
  });

  test("a company Standdown holds the letter too", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    await placeStanddown({
      companyId: f.company.id,
      scope: "company",
      reason: "Everything stops",
      placedByUserId: f.owner.id,
    });
    const due = new Date("2026-10-01T06:00:00Z");
    const result = await dispatchDueBoardLetters(due, deps(due, model().runRestricted));
    assert.equal(result.started, 0);
    assert.equal((await letters(f.company.id)).length, 0);
  });

  test("tries a failed letter again an hour later, three attempts at most", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { runRestricted } = model({ letter: "error" });
    const attempts: Array<[string, number, string | null]> = [];
    for (const at of [
      "2026-10-01T06:00:00Z",
      "2026-10-01T06:30:00Z",
      "2026-10-01T07:00:00Z",
      "2026-10-01T08:00:00Z",
      "2026-10-01T09:00:00Z",
    ]) {
      const now = new Date(at);
      await settle(await dispatchDueBoardLetters(now, deps(now, runRestricted)));
      const [letter] = await letters(f.company.id);
      attempts.push([at, letter.attempts, letter.retryAt?.toISOString() ?? null]);
    }
    assert.deepEqual(attempts, [
      ["2026-10-01T06:00:00Z", 1, "2026-10-01T07:00:00.000Z"],
      ["2026-10-01T06:30:00Z", 1, "2026-10-01T07:00:00.000Z"],
      ["2026-10-01T07:00:00Z", 2, "2026-10-01T08:00:00.000Z"],
      ["2026-10-01T08:00:00Z", MAX_SCHEDULED_ATTEMPTS, null],
      ["2026-10-01T09:00:00Z", MAX_SCHEDULED_ATTEMPTS, null],
    ]);
    const [letter] = await letters(f.company.id);
    assert.equal(letter.status, "failed");
    assert.match(letter.errorMessage, /provider is down/);
    assert.match((await settingsRow(f.company.id)).lastError, /Letter No\. 1, for September 2026/);
  });

  test("does not retry a writer that has no AI Model", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"), { writer: f.bystander });
    const { calls, runRestricted } = model();
    const due = new Date("2026-10-01T06:00:00Z");
    await settle(await dispatchDueBoardLetters(due, deps(due, runRestricted)));
    const [letter] = await letters(f.company.id);
    assert.equal(letter.status, "failed");
    assert.equal(letter.retryAt, null);
    assert.match(letter.errorMessage, /Juno needs a connected AI Model/);
    assert.equal(calls.length, 0);
  });
});

describe("writing, tracing and auditing", () => {
  async function writeSeptember(f: Fixture, script: Parameters<typeof model>[0] = {}) {
    const stub = model(script);
    const delivered: string[] = [];
    const now = new Date("2026-10-01T06:00:00Z");
    await settle(await dispatchDueBoardLetters(now, deps(now, stub.runRestricted, delivered)));
    const [letter] = await letters(f.company.id);
    return { letter, ...stub, delivered };
  }

  test("gives the writer and the auditor one restricted turn each, with one tool", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { calls } = await writeSeptember(f);
    assert.equal(calls.length, 2);
    const [writer, auditor] = calls;
    assert.deepEqual(writer.tools, ["submit_board_letter"]);
    assert.equal(writer.employeeId, f.writer.id);
    assert.equal(writer.maxSteps, 3);
    assert.match(writer.system, /Letter No\. 1 to the board of Sunwise, for September 2026/);
    assert.match(writer.system, /Progress toward the Goal, always first/);
    assert.match(writer.system, /Ada tells the truth/);
    assert.match(writer.prompt, /Routine Runs finished: 2/);
    assert.match(writer.prompt, /Untrusted evidence/);
    assert.deepEqual(auditor.tools, ["submit_audit"]);
    assert.equal(auditor.employeeId, f.auditor.id);
    assert.match(auditor.system, /You do not answer to the letter's writer, Ada/);
    assert.match(auditor.prompt, /We finished 2 Runs this month/);
  });

  test("traces every number in the prose to the figures", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { letter } = await writeSeptember(f, {
      letter: {
        summary: "We finished 2 Runs in September.",
        body: "We finished 2 Runs and 1 failed, and we earned $999,999 doing it.",
      },
    });
    const detail = await getBoardLetter(f.company.id, letter.number);
    assert.equal(detail.untracedCount, 1);
    assert.deepEqual(
      detail.trace.body.untraced.map((token) => token.text),
      ["$999,999"],
    );
    // Two figures are 1 (a Run completed, a Run failed); the words beside
    // the number say which one it quotes.
    assert.deepEqual(
      detail.trace.body.traced.map((token) => [token.text, token.figureKey]),
      [
        ["2", "work.runs"],
        ["1", "work.runsFailed"],
      ],
    );
    assert.deepEqual(detail.trace.summary.untraced, []);
  });

  test("keeps the auditor's exceptions with the letter", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const findings = [
      {
        quote: "The failure is being looked into.",
        problem: "Nothing in the evidence says anyone is.",
      },
    ];
    const { letter } = await writeSeptember(f, {
      audit: { opinion: "exceptions", note: "One claim is unsupported.", findings },
    });
    assert.equal(letter.auditStatus, "exceptions");
    const detail = await getBoardLetter(f.company.id, letter.number);
    assert.deepEqual(detail.audit.findings, findings);
    assert.equal(detail.findingsCount, 1);
    assert.equal(detail.audit.note, "One claim is unsupported.");
  });

  test("an audit that cannot run leaves the letter unverified, never clean", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const failed = await writeSeptember(f, { audit: "error" });
    assert.equal(failed.letter.status, "ready");
    assert.equal(failed.letter.auditStatus, "unverified");
    assert.match(failed.letter.auditNote, /No audit/);
    assert.deepEqual(failed.delivered, [failed.letter.id], "the board still gets the letter");
  });

  test("an auditor with no AI Model is never asked, and the letter says so", async () => {
    const f = await fixture();
    await updateBoardLetterSettings(
      f.company.id,
      { enabled: true, writerEmployeeId: f.writer.id, auditorEmployeeId: f.bystander.id },
      f.owner.id,
      new Date("2026-09-10T09:00:00Z"),
    );
    const { letter, calls } = await writeSeptember(f);
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["submit_board_letter"],
    );
    assert.equal(letter.auditStatus, "unverified");
    assert.match(letter.auditNote, /Juno has no connected AI Model/);
  });

  test("a letter written without an auditor says that none was appointed", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"), { auditor: false });
    const { letter, calls } = await writeSeptember(f);
    assert.equal(letter.auditStatus, "not_appointed");
    assert.equal(letter.auditorName, "");
    assert.equal(calls.length, 1);
  });

  test("never sends the letter to its own writer for audit, whatever the settings row says", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    // Settings the API refuses, written straight to the row.
    await AppDataSource.getRepository(BoardLetterSettings).update(
      { companyId: f.company.id },
      { auditorEmployeeId: f.writer.id },
    );
    const { letter, calls } = await writeSeptember(f);
    assert.equal(letter.auditStatus, "not_appointed");
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["submit_board_letter"],
    );
  });

  test("stores the figures before the writer starts", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"), { auditor: false });
    let seenWhileWriting: string | null = null;
    const runRestricted = async (params: RestrictedParams): Promise<RestrictedResult> => {
      const [row] = await letters(f.company.id);
      seenWhileWriting = row.status;
      assert.ok(JSON.parse(row.figuresJson).figures.length > 0, "figures are already stored");
      await params.tools[0].run(LETTER);
      return { status: "ok", finalText: "", steps: 1 };
    };
    const now = new Date("2026-10-01T06:00:00Z");
    await settle(await dispatchDueBoardLetters(now, deps(now, runRestricted)));
    assert.equal(seenWhileWriting, "writing");
  });

  test("a turn that submits nothing fails the letter", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { letter } = await writeSeptember(f, { letter: "nothing" });
    assert.equal(letter.status, "failed");
    assert.match(letter.errorMessage, /did not submit a letter/);
  });
});

describe("asking for a letter now", () => {
  test("writes the month just ended on request, even before the schedule owes it", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at);
    const { runRestricted } = model();
    const delivered: string[] = [];
    const { letter, completion } = await writeBoardLetterNow(
      f.company.id,
      f.admin.id,
      deps(at, runRestricted, delivered),
    );
    assert.equal(letter.status, "writing");
    assert.equal(letter.month, "2026-09");
    assert.equal(letter.triggerKind, "manual");
    const finished = await completion;
    assert.equal(finished?.status, "ready");
    assert.deepEqual(delivered, [letter.id]);
    const event = await AppDataSource.getRepository(AuditEvent).findOneBy({
      companyId: f.company.id,
      action: "board_letter.write",
    });
    assert.equal(event?.actorUserId, f.admin.id);
    await assert.rejects(
      writeBoardLetterNow(f.company.id, f.admin.id, deps(at, runRestricted)),
      (error: unknown) =>
        error instanceof BoardLetterConflictError && /already written/.test(error.message),
    );
  });

  test("refuses a second request while the letter is being written", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at, { auditor: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async (params: RestrictedParams): Promise<RestrictedResult> => {
      await gate;
      await params.tools[0].run(LETTER);
      return { status: "ok", finalText: "", steps: 1 };
    };
    const first = await writeBoardLetterNow(f.company.id, f.owner.id, deps(at, slow));
    await assert.rejects(
      writeBoardLetterNow(f.company.id, f.owner.id, deps(at, slow)),
      (error: unknown) =>
        error instanceof BoardLetterConflictError && /already being written/.test(error.message),
    );
    release();
    await first.completion;
  });

  test("tries a failed letter again under the same number", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at, { auditor: false });
    const failed = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(at, model({ letter: "error" }).runRestricted),
    );
    await failed.completion;
    const [broken] = await letters(f.company.id);
    assert.equal(broken.status, "failed");
    assert.equal(broken.retryAt, null, "a letter a person asked for is retried by a person");
    const again = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(at, model().runRestricted),
    );
    await again.completion;
    const [fixed] = await letters(f.company.id);
    assert.equal(fixed.number, 1);
    assert.equal(fixed.attempts, 2);
    assert.equal(fixed.status, "ready");
    assert.equal(fixed.errorMessage, "");
  });

  test("an attempt that was superseded cannot overwrite the one that replaced it", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at, { auditor: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stuck = async (params: RestrictedParams): Promise<RestrictedResult> => {
      await gate;
      await params.tools[0].run({ summary: "First draft.", body: "The first draft." });
      return { status: "ok", finalText: "", steps: 1 };
    };
    const first = await writeBoardLetterNow(f.company.id, f.owner.id, deps(at, stuck));
    // The process writing it is presumed dead: its step is past the stale window.
    await AppDataSource.getRepository(BoardLetter).update(
      { id: first.letter.id },
      { startedAt: new Date(at.getTime() - 20 * 60_000) },
    );
    const second = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(
        at,
        model({ letter: { summary: "Second draft.", body: "The second draft." } }).runRestricted,
      ),
    );
    await second.completion;
    release();
    assert.equal(await first.completion, null);
    const [letter] = await letters(f.company.id);
    assert.equal(letter.attempts, 2);
    assert.equal(letter.body, "The second draft.");
    assert.equal(letter.status, "ready");
  });

  test("refuses while the writer is stood down, and without a writer", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await assert.rejects(
      writeBoardLetterNow(f.company.id, f.owner.id, deps(at, model().runRestricted)),
      BoardLetterValidationError,
    );
    await enable(f, at);
    await placeStanddown({
      companyId: f.company.id,
      scope: "employee",
      scopeId: f.writer.id,
      reason: "Hold everything",
      placedByUserId: f.owner.id,
    });
    await assert.rejects(
      writeBoardLetterNow(f.company.id, f.owner.id, deps(at, model().runRestricted)),
      (error: unknown) =>
        error instanceof BoardLetterConflictError && /stood down/.test(error.message),
    );
    assert.equal((await letters(f.company.id)).length, 0);
  });
});

describe("asking the auditor again", () => {
  test("audits a letter nobody audited, without telling the board twice", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at, { auditor: false });
    const delivered: string[] = [];
    const written = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(at, model().runRestricted, delivered),
    );
    await written.completion;
    assert.equal((await letters(f.company.id))[0].auditStatus, "not_appointed");

    await enable(f, at);
    const { calls, runRestricted } = model();
    const again = await auditBoardLetterAgain(
      f.company.id,
      1,
      f.owner.id,
      deps(at, runRestricted, delivered),
    );
    assert.equal(again.letter.status, "auditing");
    await again.completion;
    const [letter] = await letters(f.company.id);
    assert.equal(letter.status, "ready");
    assert.equal(letter.auditStatus, "clean");
    assert.equal(letter.auditorName, "Otto");
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["submit_audit"],
    );
    assert.equal(delivered.length, 1, "the board was told once, when the letter was written");
  });

  test("never asks again once the auditor has given an opinion", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at);
    const written = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(
        at,
        model({
          audit: {
            opinion: "exceptions",
            note: "Wrong.",
            findings: [{ quote: "We finished", problem: "No." }],
          },
        }).runRestricted,
      ),
    );
    await written.completion;
    await assert.rejects(
      auditBoardLetterAgain(f.company.id, 1, f.owner.id, deps(at, model().runRestricted)),
      (error: unknown) =>
        error instanceof BoardLetterConflictError &&
        /already has the auditor's opinion/.test(error.message),
    );
  });

  test("needs an appointed auditor other than the writer", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at, { auditor: false });
    const written = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(at, model().runRestricted),
    );
    await written.completion;
    await assert.rejects(
      auditBoardLetterAgain(f.company.id, 1, f.owner.id, deps(at, model().runRestricted)),
      BoardLetterValidationError,
    );
    await assert.rejects(
      auditBoardLetterAgain(f.company.id, 9, f.owner.id, deps(at, model().runRestricted)),
      BoardLetterNotFoundError,
    );
  });
});

describe("recovering from a restart", () => {
  async function abandoned(f: Fixture, status: "writing" | "auditing", startedAt: Date) {
    return insert(BoardLetter, {
      companyId: f.company.id,
      number: 1,
      month: "2026-09",
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      timeZone: "UTC",
      status,
      triggerKind: "schedule",
      attempts: 1,
      startedAt,
      writerEmployeeId: f.writer.id,
      writerName: "Ada",
      auditStatus: status === "auditing" ? "pending" : "pending",
      body: status === "auditing" ? "Written before the restart." : "",
    });
  }

  test("a writing step a dead process left behind fails and is tried again", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const now = new Date("2026-10-01T07:00:00Z");
    await abandoned(f, "writing", new Date("2026-10-01T06:00:00Z"));
    assert.equal(
      await reconcileStaleBoardLetters(new Date("2026-10-01T06:10:00Z")),
      0,
      "not stale yet",
    );
    assert.equal(await reconcileStaleBoardLetters(now), 1);
    const [letter] = await letters(f.company.id);
    assert.equal(letter.status, "failed");
    assert.match(letter.errorMessage, /interrupted/);
    assert.equal(letter.retryAt?.toISOString(), "2026-10-01T08:00:00.000Z");
    assert.equal(
      (await settingsRow(f.company.id)).nextLetterAt?.toISOString(),
      "2026-10-01T08:00:00.000Z",
    );
  });

  test("an audit a dead process left behind finishes unverified and still reaches the board", async () => {
    const f = await fixture();
    const delivered: string[] = [];
    const letter = await abandoned(f, "auditing", new Date("2026-10-01T06:00:00Z"));
    await reconcileStaleBoardLetters(new Date("2026-10-01T07:00:00Z"), {
      deliver: async (id) => delivered.push(id),
    });
    const [finished] = await letters(f.company.id);
    assert.equal(finished.status, "ready");
    assert.equal(finished.auditStatus, "unverified");
    assert.match(finished.auditNote, /interrupted/);
    assert.deepEqual(delivered, [letter.id]);
  });
});

describe("telling the board", () => {
  const originalLog = console.log;

  test("reaches every owner and admin once, by bell and by email, and no one else", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at);
    console.log = () => undefined;
    try {
      const written = await writeBoardLetterNow(f.company.id, f.owner.id, {
        now: () => at,
        runRestricted: model().runRestricted,
      });
      await written.completion;
      const [letter] = await letters(f.company.id);
      assert.ok(letter.deliveredAt, "delivery is claimed");

      const bells = await AppDataSource.getRepository(Notification).find({
        where: { companyId: f.company.id, kind: "board_letter_ready" },
      });
      assert.deepEqual(bells.map((bell) => bell.userId).sort(), [f.owner.id, f.admin.id].sort());
      assert.equal(bells[0].link, "/c/sunwise/tldrs/letters/1");
      assert.equal(bells[0].title, "Letter No. 1 to the board · September 2026");
      assert.equal(bells[0].entityKind, "board_letter");

      const emails = await AppDataSource.getRepository(EmailLog).find({
        where: { companyId: f.company.id },
      });
      assert.deepEqual(emails.map((email) => email.toAddress).sort(), [
        "admin@sunwise.test",
        "owner@sunwise.test",
      ]);
      assert.equal(emails[0].subject, "Letter No. 1 to the board · September 2026 — Sunwise");
      assert.match(emails[0].bodyPreview, /To the board of Sunwise,/);
      assert.match(emails[0].bodyPreview, /We finished 2 Runs this month/);
      assert.match(emails[0].bodyPreview, /Audited by Otto: no exceptions\./);

      assert.equal(await deliverBoardLetter(letter.id), false, "a second delivery tells no one");
      assert.equal(
        await AppDataSource.getRepository(Notification).countBy({
          companyId: f.company.id,
          kind: "board_letter_ready",
        }),
        2,
      );
    } finally {
      console.log = originalLog;
    }
  });
});

describe("removing an AI Employee", () => {
  test("switches letters off with the writer, ends the auditor's appointment, and keeps the names on letters", async () => {
    const f = await fixture();
    const at = new Date("2026-10-20T09:00:00Z");
    await enable(f, at);
    const written = await writeBoardLetterNow(
      f.company.id,
      f.owner.id,
      deps(at, model().runRestricted),
    );
    await written.completion;

    await detachEmployeeFromBoardLetters(f.company.id, f.auditor.id);
    let settings = await settingsRow(f.company.id);
    assert.equal(settings.auditorEmployeeId, null);
    assert.equal(settings.auditorAppointedByUserId, null);
    assert.equal(settings.enabled, true);

    await detachEmployeeFromBoardLetters(f.company.id, f.writer.id);
    settings = await settingsRow(f.company.id);
    assert.equal(settings.writerEmployeeId, null);
    assert.equal(settings.enabled, false);
    assert.equal(settings.nextLetterAt, null);
    assert.match(settings.lastError, /writer was deleted/);

    const [letter] = await letters(f.company.id);
    assert.equal(letter.writerEmployeeId, null);
    assert.equal(letter.auditorEmployeeId, null);
    assert.equal(letter.writerName, "Ada");
    assert.equal(letter.auditorName, "Otto");
  });
});

describe("reading letters", () => {
  test("lists them newest first, and opens one in full only within its company", async () => {
    const f = await fixture();
    await enable(f, new Date("2026-09-10T09:00:00Z"));
    const { runRestricted } = model();
    for (const at of ["2026-10-01T06:00:00Z", "2026-11-01T06:00:00Z"]) {
      const now = new Date(at);
      await settle(await dispatchDueBoardLetters(now, deps(now, runRestricted)));
    }
    const list = await listBoardLetters(f.company.id);
    assert.deepEqual(
      list.map((item) => [item.number, item.monthLabel, item.auditStatus]),
      [
        [2, "October 2026", "clean"],
        [1, "September 2026", "clean"],
      ],
    );
    assert.equal("body" in list[0], false, "the list carries no letter bodies");

    const detail = await getBoardLetter(f.company.id, 1);
    assert.equal(detail.body, LETTER.body);
    assert.ok(detail.figures && detail.figures.figures.length > 0);
    assert.ok(detail.evidence);
    assert.equal(detail.figures?.month, "2026-09");

    const elsewhere = await insert(Company, {
      name: "Other",
      slug: "other-co",
      ownerId: f.owner.id,
    });
    await assert.rejects(getBoardLetter(elsewhere.id, 1), BoardLetterNotFoundError);
    assert.deepEqual(await listBoardLetters(elsewhere.id), []);
  });
});
