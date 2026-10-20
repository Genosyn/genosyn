import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BoardLetterAuditStatus } from "../db/entities/BoardLetter.js";
import type { LetterFigures } from "./boardLetterFigures.js";
import { auditLine, boardLetterEmail, type BoardLetterEmailInput } from "./boardLetterNotice.js";

const FIGURES: LetterFigures = {
  version: 1,
  computedAt: "2026-10-01T06:00:00.000Z",
  month: "2026-09",
  timeZone: "",
  periodStart: "2026-09-01T00:00:00.000Z",
  periodEnd: "2026-10-01T00:00:00.000Z",
  ledgerFrom: "2026-09-01",
  ledgerTo: "2026-09-30",
  currency: "USD",
  goals: [
    {
      id: "roofs",
      title: "Put solar on a million roofs",
      unit: "roofs",
      direction: "increase_to",
      status: "active",
      current: 6_200,
      target: 1_000_000,
      start: null,
      progress: 0.0062,
      met: false,
      basis: "employee",
      awaitingConfirmation: false,
      updatedAt: null,
      dueAt: null,
      settledAt: null,
    },
  ],
  figures: [
    {
      key: "goal.roofs.current",
      group: "goals",
      label: "Put solar on a million roofs: where it stands",
      kind: "number",
      value: 6_200,
      display: "6,200 roofs",
      source: "Goals",
      href: "/goals",
      note: "Reported by an AI Employee.",
    },
    {
      key: "goal.roofs.target",
      group: "goals",
      label: "Put solar on a million roofs: target",
      kind: "number",
      value: 1_000_000,
      display: "1,000,000 roofs",
      source: "Goals",
      href: "/goals",
    },
    {
      key: "money.revenue",
      group: "money",
      label: "Revenue this month",
      kind: "money",
      value: 4_800_000,
      display: "$4,800,000",
      source: "Profit and loss",
      href: null,
    },
  ],
};

function input(overrides: Partial<BoardLetterEmailInput> = {}): BoardLetterEmailInput {
  return {
    companyName: "Sunwise",
    companySlug: "sunwise",
    publicUrl: "https://genosyn.example",
    letter: {
      number: 36,
      month: "2026-09",
      summary: "Year three closed at 41% growth.",
      body: "Year three closed at 41% growth.\n\nOur largest mistake came in March.",
      writerName: "Ada",
      writerRole: "AI CEO",
      auditStatus: "exceptions",
      auditorName: "Otto",
      auditNote: "One claim is unsupported.",
    },
    figures: FIGURES,
    findings: [{ quote: "Our largest mistake came in March.", problem: "It was in April." }],
    untraced: [{ text: "41%", start: 26, end: 29, kind: "percent", value: 41 }],
    ...overrides,
  };
}

describe("the letter's email", () => {
  test("carries the whole letter: the Goal first, the figures, the prose, the audit", () => {
    const { subject, text } = boardLetterEmail(input());
    assert.equal(subject, "Letter No. 36 to the board · September 2026 — Sunwise");
    const order = [
      "Letter No. 36 to the board of Sunwise · September 2026",
      "Toward the Goal\n- Put solar on a million roofs: 6,200 roofs of 1,000,000 roofs (Reported by an AI Employee.)",
      "Figures\n- Revenue this month: $4,800,000",
      "To the board of Sunwise,",
      "Our largest mistake came in March.",
      "Ada\nAI CEO, Sunwise",
      'Audited by Otto: exceptions reported.\nOne claim is unsupported.\n- "Our largest mistake came in March.": It was in April.',
      'Numbers in this letter that match none of its figures: "41%".',
      "Read it with the source of every figure: https://genosyn.example/c/sunwise/tldrs/letters/36",
      "This letter goes to the owners and admins of Sunwise.",
    ];
    let cursor = -1;
    for (const part of order) {
      const at = text.indexOf(part);
      assert.ok(at > cursor, `out of order or missing: ${part}`);
      cursor = at;
    }
  });

  test("leaves out what the letter does not have", () => {
    const { text } = boardLetterEmail(
      input({
        figures: { ...FIGURES, goals: [], figures: [] },
        findings: [],
        untraced: [],
        letter: { ...input().letter, auditStatus: "not_appointed", auditNote: "" },
      }),
    );
    assert.doesNotMatch(text, /Toward the Goal/);
    assert.doesNotMatch(text, /\nFigures\n/);
    assert.match(text, /Every number in this letter matches one of its figures\./);
    assert.match(text, /Not audited: the board has not appointed an auditor\./);
  });
});

describe("the audit line", () => {
  test("never reads a missing opinion as a clean one", () => {
    const lines: Record<BoardLetterAuditStatus, string> = {
      clean: "Audited by Otto: no exceptions.",
      exceptions: "Audited by Otto: exceptions reported.",
      unverified: "Not audited: Otto could not give an opinion.",
      not_appointed: "Not audited: the board has not appointed an auditor.",
      pending: "The audit has not finished yet.",
    };
    for (const [status, line] of Object.entries(lines)) {
      assert.equal(
        auditLine({ auditStatus: status as BoardLetterAuditStatus, auditorName: "Otto" }),
        line,
      );
    }
    assert.equal(
      auditLine({ auditStatus: "unverified", auditorName: "" }),
      "Not audited: the board's auditor could not give an opinion.",
    );
  });
});
