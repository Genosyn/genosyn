import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_DECISION_STACK_INSTRUCTIONS,
  MAX_DECISION_STACK_INSTRUCTIONS_LENGTH,
  MAX_DECISION_STACK_INSTRUCTION_LINES,
  decisionStackInstructionLines,
  decisionStackInstructionsProblem,
  effectiveDecisionStackInstructions,
  normalizeDecisionStackInstructions,
  sameDecisionStackInstructions,
} from "../../shared/decisionStackInstructions.js";
import { HUMAN_DECISION_GUIDANCE } from "./humanDecisionGuidance.js";

/**
 * The Decision stack's instructions box rules, shared by the settings page,
 * the API, every employee briefing and the server-side screen. The numbers the
 * screen cites are the numbers these rules assign, so the edge cases live here.
 */

describe("the default instructions", () => {
  const lines = decisionStackInstructionLines(DEFAULT_DECISION_STACK_INSTRUCTIONS);
  const text = DEFAULT_DECISION_STACK_INSTRUCTIONS.toLowerCase();

  test("are a short handful of plain-language lines", () => {
    assert.ok(lines.length >= 3 && lines.length <= 6, `${lines.length} lines`);
    assert.ok(DEFAULT_DECISION_STACK_INSTRUCTIONS.length < 700);
    for (const line of lines) {
      assert.ok(line.length <= 200, `a line a person can read at a glance: ${line}`);
      // Written for people, not engineers: no tool names, ids or jargon.
      assert.doesNotMatch(line, /request_decision|humanDecisionReason|Workstream|Grant|MCP|API/);
    }
  });

  test("keep the stack for the major choices HUMAN_DECISION_GUIDANCE names", () => {
    // spending / financial or contractual commitments
    assert.match(text, /spending money/);
    assert.match(text, /contracts/);
    assert.match(text, /commitments/);
    // legal, security and reputational risk
    assert.match(text, /legal, security or reputation risks/);
    // hard-to-undo actions
    assert.match(text, /hard to undo/);
    // conflicting Policies and strategic direction
    assert.match(text, /policies that disagree/);
    assert.match(text, /direction of the company/);
    // …which the guidance itself also reserves the stack for.
    for (const phrase of ["financial", "contractual", "legal", "security", "reputational", "Policies", "strategic direction", "difficult to reverse"]) {
      assert.ok(HUMAN_DECISION_GUIDANCE.includes(phrase), phrase);
    }
  });

  test("keep routine upkeep and anything reversible off the stack", () => {
    for (const phrase of [
      "routine upkeep",
      "wording",
      "labels",
      "follow-ups",
      "research",
      "duplicates",
      "look up yourself",
      "easy to undo",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
    assert.match(text, /note what you chose/);
  });

  test("are already in the stored shape and within every limit", () => {
    assert.equal(
      normalizeDecisionStackInstructions(DEFAULT_DECISION_STACK_INSTRUCTIONS),
      DEFAULT_DECISION_STACK_INSTRUCTIONS,
    );
    assert.equal(decisionStackInstructionsProblem(DEFAULT_DECISION_STACK_INSTRUCTIONS), null);
    assert.equal(lines.length, DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n").length);
  });
});

describe("what the stored column means", () => {
  test("null and a missing value follow the current default", () => {
    assert.equal(effectiveDecisionStackInstructions(null), DEFAULT_DECISION_STACK_INSTRUCTIONS);
    assert.equal(
      effectiveDecisionStackInstructions(undefined),
      DEFAULT_DECISION_STACK_INSTRUCTIONS,
    );
  });

  test("an empty string is a deliberate no-instructions", () => {
    assert.equal(effectiveDecisionStackInstructions(""), "");
    assert.deepEqual(decisionStackInstructionLines(""), []);
  });

  test("the company's own text is used as written", () => {
    assert.equal(
      effectiveDecisionStackInstructions("Only ask about spending over $500."),
      "Only ask about spending over $500.",
    );
  });
});

describe("normalizing and numbering", () => {
  test("line endings, trailing spaces and blank edges are tidied; words are kept", () => {
    assert.equal(
      normalizeDecisionStackInstructions("\r\n  Ask about contracts  \r\nSkip labels\t\r\r\n"),
      "  Ask about contracts\nSkip labels",
    );
  });

  test("list markers people type are not part of the instruction", () => {
    assert.deepEqual(
      decisionStackInstructionLines("- Ask about contracts\n2) Skip labels\n• Never ask about wording"),
      ["Ask about contracts", "Skip labels", "Never ask about wording"],
    );
  });

  test("amounts and percentages are words, not list markers", () => {
    assert.deepEqual(decisionStackInstructionLines("-5% discounts need us\n1.5x price rises too"), [
      "-5% discounts need us",
      "1.5x price rises too",
    ]);
  });

  test("blank lines between instructions do not get numbers", () => {
    assert.deepEqual(decisionStackInstructionLines("One\n\n\nTwo"), ["One", "Two"]);
  });

  test("a row edited outside the app still yields a bounded list", () => {
    const many = Array.from({ length: 45 }, (_, index) => `Rule ${index + 1}`).join("\n");
    assert.equal(decisionStackInstructionLines(many).length, MAX_DECISION_STACK_INSTRUCTION_LINES);
  });

  test("non-English instructions are kept as written", () => {
    assert.deepEqual(decisionStackInstructionLines("Frag uns nur bei Verträgen.\n契約についてのみ聞いてください。"), [
      "Frag uns nur bei Verträgen.",
      "契約についてのみ聞いてください。",
    ]);
  });
});

describe("what cannot be saved", () => {
  test("exactly the character limit is fine; one more is a sentence", () => {
    const atLimit = "a".repeat(MAX_DECISION_STACK_INSTRUCTIONS_LENGTH);
    assert.equal(decisionStackInstructionsProblem(atLimit), null);
    assert.equal(
      decisionStackInstructionsProblem(`${atLimit}a`),
      "Keep the instructions under 4,000 characters.",
    );
  });

  test("trailing whitespace past the limit does not count against it", () => {
    const atLimit = "a".repeat(MAX_DECISION_STACK_INSTRUCTIONS_LENGTH);
    assert.equal(decisionStackInstructionsProblem(`${atLimit}   \n\n`), null);
  });

  test("exactly thirty instructions is fine; thirty-one is refused", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, index) => `Rule ${index + 1}`).join("\n");
    assert.equal(decisionStackInstructionsProblem(lines(30)), null);
    assert.equal(
      decisionStackInstructionsProblem(lines(31)),
      "Keep it to 30 instructions or fewer, one per line.",
    );
  });

  test("control characters are refused; tabs and new lines are layout", () => {
    assert.equal(
      decisionStackInstructionsProblem("Ask about contracts\u0007"),
      "Instructions can only contain printable characters.",
    );
    assert.equal(
      decisionStackInstructionsProblem("Ask\u0000 about contracts"),
      "Instructions can only contain printable characters.",
    );
    assert.equal(decisionStackInstructionsProblem("Ask\tabout\ncontracts"), null);
  });

  test("an empty box is allowed — it means no instructions", () => {
    assert.equal(decisionStackInstructionsProblem(""), null);
    assert.equal(decisionStackInstructionsProblem("  \n \n"), null);
  });
});

describe("unchanged", () => {
  test("trailing spaces and line endings are not a change", () => {
    assert.equal(
      sameDecisionStackInstructions(
        DEFAULT_DECISION_STACK_INSTRUCTIONS,
        `${DEFAULT_DECISION_STACK_INSTRUCTIONS.replace(/\n/g, "\r\n")}   \n\n`,
      ),
      true,
    );
  });

  test("a changed word is a change", () => {
    assert.equal(
      sameDecisionStackInstructions(
        DEFAULT_DECISION_STACK_INSTRUCTIONS,
        DEFAULT_DECISION_STACK_INSTRUCTIONS.replace("big", "large"),
      ),
      false,
    );
  });
});
