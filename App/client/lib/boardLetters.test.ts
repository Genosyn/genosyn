import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LetterFigure, LetterGoal, LetterTrace } from "./api.js";
import {
  figureLink,
  figureSections,
  goalStandingLabel,
  letterParagraphs,
  letterStatusBadge,
  traceBadge,
} from "./boardLetters.js";

function traceOf(body: string, traced: Array<[string, string]>, untraced: string[]): LetterTrace {
  const at = (text: string) => {
    const start = body.indexOf(text);
    assert.ok(start >= 0, text);
    return { text, start, end: start + text.length, kind: "plain" as const, value: 0 };
  };
  return {
    traced: traced.map(([text, figureKey]) => ({ ...at(text), figureKey })),
    untraced: untraced.map(at),
  };
}

describe("a letter's paragraphs", () => {
  test("split on blank lines, with every number marked by what the trace found", () => {
    const body = "We finished 214 Runs.\n\nRevenue was $9,999 and 3 failed.";
    const paragraphs = letterParagraphs(
      body,
      traceOf(
        body,
        [
          ["214", "work.runs"],
          ["3", "work.runsFailed"],
        ],
        ["$9,999"],
      ),
    );
    assert.deepEqual(paragraphs, [
      [
        { kind: "text", text: "We finished " },
        { kind: "traced", text: "214", figureKey: "work.runs" },
        { kind: "text", text: " Runs." },
      ],
      [
        { kind: "text", text: "Revenue was " },
        { kind: "untraced", text: "$9,999" },
        { kind: "text", text: " and " },
        { kind: "traced", text: "3", figureKey: "work.runsFailed" },
        { kind: "text", text: " failed." },
      ],
    ]);
  });

  test("never draws a mark over words that are not the number it names", () => {
    const body = "Revenue was $9,999.";
    const stale: LetterTrace = {
      traced: [],
      untraced: [{ text: "$1,000", start: 12, end: 18, kind: "money", value: 1000 }],
    };
    assert.deepEqual(letterParagraphs(body, stale), [
      [{ kind: "text", text: "Revenue was $9,999." }],
    ]);
  });

  test("keeps a single line break inside its paragraph, and drops empty ones", () => {
    assert.deepEqual(letterParagraphs("\n\nOne\nline.\n\n\n\nTwo.\n\n", null), [
      [{ kind: "text", text: "One\nline." }],
      [{ kind: "text", text: "Two." }],
    ]);
    assert.deepEqual(letterParagraphs("", null), []);
  });
});

describe("where a letter stands", () => {
  const badge = (status: string, auditStatus: string, findingsCount = 0) =>
    letterStatusBadge({
      status: status as never,
      auditStatus: auditStatus as never,
      findingsCount,
    });

  test("says plainly when nobody audited it, never that it was clean", () => {
    assert.deepEqual(badge("ready", "clean"), { label: "Audited · no exceptions", tone: "good" });
    assert.deepEqual(badge("ready", "exceptions", 1), {
      label: "Audited · 1 exception",
      tone: "warn",
    });
    assert.deepEqual(badge("ready", "exceptions", 3), {
      label: "Audited · 3 exceptions",
      tone: "warn",
    });
    assert.deepEqual(badge("ready", "unverified"), { label: "Not audited", tone: "bad" });
    assert.deepEqual(badge("ready", "not_appointed"), {
      label: "No auditor appointed",
      tone: "neutral",
    });
  });

  test("follows the letter while it is being written and audited", () => {
    assert.equal(badge("writing", "pending").label, "Being written");
    assert.equal(badge("auditing", "pending").label, "With the auditor");
    assert.deepEqual(badge("failed", "pending"), { label: "Not written", tone: "bad" });
  });

  test("reports the trace only once there is prose to trace", () => {
    assert.equal(traceBadge({ status: "writing", untracedCount: 0 }), null);
    assert.equal(traceBadge({ status: "failed", untracedCount: 0 }), null);
    assert.deepEqual(traceBadge({ status: "ready", untracedCount: 0 }), {
      label: "Every number traced",
      tone: "good",
    });
    assert.deepEqual(traceBadge({ status: "auditing", untracedCount: 1 }), {
      label: "1 number untraced",
      tone: "warn",
    });
    assert.equal(traceBadge({ status: "ready", untracedCount: 4 })?.label, "4 numbers untraced");
  });
});

describe("the figures", () => {
  const figure = (key: string, group: LetterFigure["group"], display = "1"): LetterFigure => ({
    key,
    group,
    label: key,
    kind: "count",
    value: 1,
    display,
    source: "",
    href: null,
  });

  test("sit under their headings, money first, with Goals and empty groups left out", () => {
    const sections = figureSections([
      figure("work.runs", "work"),
      figure("goal.g.current", "goals"),
      figure("money.revenue", "money"),
      figure("work.lessons", "work"),
    ]);
    assert.deepEqual(
      sections.map((section) => [section.title, section.figures.map((item) => item.key)]),
      [
        ["Where the money went", ["money.revenue"]],
        ["The work", ["work.runs", "work.lessons"]],
      ],
    );
  });

  test("say where a Goal stands in its own unit", () => {
    const goal: LetterGoal = {
      id: "g",
      title: "Roofs",
      unit: "roofs",
      direction: "increase_to",
      status: "active",
      current: 6200,
      target: 1_000_000,
      start: null,
      progress: 0.0062,
      met: false,
      basis: "member",
      awaitingConfirmation: false,
      updatedAt: null,
      dueAt: null,
      settledAt: null,
    };
    const figures = [
      figure("goal.g.current", "goals", "6,200 roofs"),
      figure("goal.g.target", "goals", "1,000,000 roofs"),
    ];
    assert.equal(goalStandingLabel(goal, figures), "6,200 roofs of 1,000,000 roofs");
    assert.equal(goalStandingLabel(goal, []), "No value reported yet");
    assert.equal(goalStandingLabel({ ...goal, status: "achieved" }, figures), "Achieved");
    assert.equal(goalStandingLabel({ ...goal, status: "missed" }, figures), "Missed");
  });

  test("link only to pages inside the company", () => {
    assert.equal(
      figureLink("sunwise", {
        href: "/finance/reports?report=income&from=2026-09-01&to=2026-09-30",
      }),
      "/c/sunwise/finance/reports?report=income&from=2026-09-01&to=2026-09-30",
    );
    assert.equal(figureLink("sunwise", { href: null }), null);
    assert.equal(figureLink("sunwise", { href: "https://example.com" }), null);
  });
});
