import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import type { runRestrictedEmployeeAgent } from "./agent/runEmployee.js";
import { auditBoardLetter } from "./boardLetterAudit.js";
import type { LetterContext } from "./boardLetterWriting.js";
import { placeStanddown, stopStanddowns } from "./standdowns.js";

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  stopStanddowns();
});
afterEach(() => stopStanddowns());

type RestrictedParams = Parameters<typeof runRestrictedEmployeeAgent>[0];
type RestrictedResult = Awaited<ReturnType<typeof runRestrictedEmployeeAgent>>;

const LETTER = {
  summary: "Revenue grew and nothing went wrong.",
  body: "Revenue was $4.8M. Nothing went wrong this month.",
};

function context(): LetterContext {
  return {
    companyName: "Sunwise",
    letterNumber: 12,
    monthLabel: "September 2026",
    figures: {
      version: 1,
      computedAt: "2026-10-01T06:00:00.000Z",
      month: "2026-09",
      timeZone: "",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      ledgerFrom: "2026-09-01",
      ledgerTo: "2026-09-30",
      currency: "USD",
      goals: [],
      figures: [
        {
          key: "work.runsFailed",
          group: "work",
          label: "Runs that failed",
          kind: "count",
          value: 3,
          display: "3",
          source: "Runs",
          href: "/routines",
        },
      ],
    },
    evidence: {
      goals: [],
      briefings: [],
      failures: [
        {
          routine: "Reconcile",
          employee: "Vera",
          count: 3,
          lastAt: "2026-09-20T00:00:00.000Z",
          lastStatus: "failed",
          reasons: ["Bank feed down"],
        },
      ],
      lessons: [],
      standdowns: [],
      decisions: [],
      truncated: false,
    },
  };
}

async function people(connected = true) {
  const company = await insert(Company, {
    name: "Sunwise",
    slug: "sunwise-audit",
    ownerId: "owner",
  });
  const make = async (name: string, withModel: boolean) => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name,
      slug: name.toLowerCase(),
      role: "Auditor",
      soulBody: "",
    });
    if (withModel) {
      await insertEmployeeModel({
        employeeId: employee.id,
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
    return employee;
  };
  return { company, writer: await make("Ada", true), auditor: await make("Otto", connected) };
}

function turn(script: (params: RestrictedParams) => Promise<RestrictedResult | never>) {
  const seen: RestrictedParams[] = [];
  return {
    seen,
    runRestricted: async (params: RestrictedParams) => {
      seen.push(params);
      return script(params);
    },
  };
}

const ok: RestrictedResult = { status: "ok", finalText: "", steps: 1 };

async function audit(
  auditor: AIEmployee,
  writer: AIEmployee,
  runRestricted: (params: RestrictedParams) => Promise<RestrictedResult>,
  untraced = [{ text: "$9B", start: 0, end: 3, kind: "money" as const, value: 9e9 }],
) {
  return auditBoardLetter({
    auditor,
    writerEmployeeId: writer.id,
    writerName: writer.name,
    context: context(),
    letter: LETTER,
    untraced,
    dependencies: { runRestricted },
  });
}

describe("the auditor's opinion", () => {
  test("is asked for in one restricted turn, independent of the writer", async () => {
    const { writer, auditor } = await people();
    const { seen, runRestricted } = turn(async (params) => {
      await params.tools[0].run({
        opinion: "exceptions",
        note: "The letter hides three failed Runs.",
        findings: [
          { quote: "Nothing went wrong this month.", problem: "Three Runs of Reconcile failed." },
        ],
      });
      return ok;
    });
    const result = await audit(auditor, writer, runRestricted);
    assert.deepEqual(result, {
      status: "exceptions",
      note: "The letter hides three failed Runs.",
      findings: [
        { quote: "Nothing went wrong this month.", problem: "Three Runs of Reconcile failed." },
      ],
    });
    const [params] = seen;
    assert.deepEqual(
      params.tools.map((tool) => tool.name),
      ["submit_audit"],
    );
    assert.equal(params.employeeId, auditor.id);
    assert.match(params.system, /The board of Sunwise appointed you/);
    assert.match(params.system, /You do not answer to the letter's writer, Ada/);
    assert.match(params.system, /leaves out: a Goal behind or missed, failed or errored work/);
    const prompt = JSON.stringify(params.messages);
    assert.match(prompt, /Nothing went wrong this month\./);
    assert.match(prompt, /Numbers in the letter that match none of the figures: \\"\$9B\\"/);
    assert.match(prompt, /Bank feed down/);
  });

  test("says so when every number matched", async () => {
    const { writer, auditor } = await people();
    const { seen, runRestricted } = turn(async (params) => {
      await params.tools[0].run({ opinion: "clean", note: "Accurate.", findings: [] });
      return ok;
    });
    const result = await audit(auditor, writer, runRestricted, []);
    assert.equal(result.status, "clean");
    assert.match(
      JSON.stringify(seen[0].messages),
      /Every number in the letter matches one of the figures/,
    );
  });

  test("refuses a clean opinion with findings, or exceptions without any", async () => {
    const { writer, auditor } = await people();
    const replies: boolean[] = [];
    const { runRestricted } = turn(async (params) => {
      const tool = params.tools[0];
      replies.push(
        Boolean(
          (
            await tool.run({
              opinion: "clean",
              note: "Fine.",
              findings: [{ quote: "a", problem: "b" }],
            })
          ).isError,
        ),
      );
      replies.push(
        Boolean((await tool.run({ opinion: "exceptions", note: "Bad.", findings: [] })).isError),
      );
      replies.push(
        Boolean((await tool.run({ opinion: "clean", note: "Fine.", findings: [] })).isError),
      );
      return ok;
    });
    const result = await audit(auditor, writer, runRestricted);
    assert.deepEqual(replies, [true, true, false]);
    assert.equal(result.status, "clean");
  });

  test("keeps the first opinion, and an opinion given before the turn failed", async () => {
    const { writer, auditor } = await people();
    const { runRestricted } = turn(async (params) => {
      await params.tools[0].run({ opinion: "clean", note: "First.", findings: [] });
      await params.tools[0].run({
        opinion: "exceptions",
        note: "Second.",
        findings: [{ quote: "a", problem: "b" }],
      });
      return { status: "error", error: "Connection reset." };
    });
    const result = await audit(auditor, writer, runRestricted);
    assert.equal(result.status, "clean");
    assert.equal(result.note, "First.");
  });
});

describe("an audit that cannot run", () => {
  test("is unverified when the turn fails or ends without an opinion", async () => {
    const { writer, auditor } = await people();
    const failed = await audit(
      auditor,
      writer,
      turn(async () => ({ status: "error", error: "Timed out." })).runRestricted,
    );
    assert.equal(failed.status, "unverified");
    assert.match(failed.note, /Timed out\./);
    const silent = await audit(auditor, writer, turn(async () => ok).runRestricted);
    assert.equal(silent.status, "unverified");
    assert.match(silent.note, /without giving an opinion/);
    const thrown = await audit(
      auditor,
      writer,
      turn(async () => {
        throw new Error("Socket hang up");
      }).runRestricted,
    );
    assert.equal(thrown.status, "unverified");
    assert.match(thrown.note, /Socket hang up/);
  });

  test("is unverified, without a model call, for an auditor with no AI Model", async () => {
    const { writer, auditor } = await people(false);
    const { seen, runRestricted } = turn(async () => ok);
    const result = await audit(auditor, writer, runRestricted);
    assert.equal(result.status, "unverified");
    assert.match(result.note, /Otto has no connected AI Model/);
    assert.equal(seen.length, 0);
  });

  test("is unverified, without a model call, while the auditor is stood down", async () => {
    const { company, writer, auditor } = await people();
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: auditor.id,
      reason: "Under review",
      placedByUserId: "owner",
    });
    const { seen, runRestricted } = turn(async () => ok);
    const result = await audit(auditor, writer, runRestricted);
    assert.equal(result.status, "unverified");
    assert.match(result.note, /Otto is stood down \(Under review\)/);
    assert.equal(seen.length, 0);
  });

  test("is unverified when the auditor would be auditing its own letter", async () => {
    const { writer } = await people();
    const { seen, runRestricted } = turn(async () => ok);
    const result = await audit(writer, writer, runRestricted);
    assert.equal(result.status, "unverified");
    assert.match(result.note, /cannot be the AI Employee who wrote the letter/);
    assert.equal(seen.length, 0);
  });
});
