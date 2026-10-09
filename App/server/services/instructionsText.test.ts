import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  instructionsTextLines,
  instructionsTextProblem,
  normalizeInstructionsText,
  sameInstructionsText,
} from "../../shared/instructionsText.js";
import {
  MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH,
  MAX_MAIL_ANALYSIS_INSTRUCTION_LINES,
  mailAnalysisInstructionLines,
  mailAnalysisInstructionsProblem,
  normalizeMailAnalysisInstructions,
  sameMailAnalysisInstructions,
} from "../../shared/mailAnalysisInstructions.js";
import {
  MAX_DECISION_STACK_INSTRUCTIONS_LENGTH,
  MAX_DECISION_STACK_INSTRUCTION_LINES,
  decisionStackInstructionLines,
  decisionStackInstructionsProblem,
  normalizeDecisionStackInstructions,
  sameDecisionStackInstructions,
} from "../../shared/decisionStackInstructions.js";

/**
 * Every instructions box follows one set of rules (`shared/instructionsText.ts`).
 * The mailbox's box was first; the Decision stack's reuses it. These pin that
 * moving the mailbox's rules into the shared module changed nothing about
 * them, and that both boxes answer the same text the same way.
 */

const SAMPLES = [
  "",
  "   \n\t\n  ",
  "Star mail from Ana.",
  "\r\n- Star replies  \r\n\r\n* Archive receipts\r1) Label invoices Finance\n— Mark newsletters read\n\n",
  "-5% coupons\n1.5x upsells\n12. numbered twelve",
  "Line one\u0007",
  "a".repeat(4_000),
  "a".repeat(4_001),
  Array.from({ length: 30 }, (_, index) => `Rule ${index + 1}`).join("\n"),
  Array.from({ length: 31 }, (_, index) => `- Rule ${index + 1}`).join("\n"),
  Array.from({ length: 45 }, (_, index) => `Rule ${index + 1}`).join("\n\n"),
  "契約\nVerträge",
];

describe("the shared rules", () => {
  test("normalize, split, refuse and compare exactly as the mailbox box always did", () => {
    const limits = {
      maxLength: MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH,
      maxLines: MAX_MAIL_ANALYSIS_INSTRUCTION_LINES,
    };
    for (const sample of SAMPLES) {
      assert.equal(normalizeMailAnalysisInstructions(sample), normalizeInstructionsText(sample));
      assert.deepEqual(
        mailAnalysisInstructionLines(sample),
        instructionsTextLines(sample, limits.maxLines),
      );
      assert.equal(mailAnalysisInstructionsProblem(sample), instructionsTextProblem(sample, limits));
      assert.equal(
        sameMailAnalysisInstructions(sample, `${sample}  \n`),
        sameInstructionsText(sample, `${sample}  \n`),
      );
    }
  });

  test("the Decision stack box answers every sample the same way as the mailbox box", () => {
    // Same limits today, so one rule set must give one answer. If the limits
    // ever diverge, this is the test that says so on purpose.
    assert.equal(MAX_DECISION_STACK_INSTRUCTIONS_LENGTH, MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH);
    assert.equal(MAX_DECISION_STACK_INSTRUCTION_LINES, MAX_MAIL_ANALYSIS_INSTRUCTION_LINES);
    for (const sample of SAMPLES) {
      assert.equal(normalizeDecisionStackInstructions(sample), normalizeMailAnalysisInstructions(sample));
      assert.deepEqual(decisionStackInstructionLines(sample), mailAnalysisInstructionLines(sample));
      assert.equal(decisionStackInstructionsProblem(sample), mailAnalysisInstructionsProblem(sample));
      assert.equal(
        sameDecisionStackInstructions(sample, sample.toUpperCase()),
        sameMailAnalysisInstructions(sample, sample.toUpperCase()),
      );
    }
  });

  test("limits are the caller's, and the sentence names them", () => {
    assert.equal(
      instructionsTextProblem("abcdef", { maxLength: 5, maxLines: 10 }),
      "Keep the instructions under 5 characters.",
    );
    assert.equal(
      instructionsTextProblem("a\nb\nc", { maxLength: 100, maxLines: 2 }),
      "Keep it to 2 instructions or fewer, one per line.",
    );
    assert.equal(
      instructionsTextProblem("x".repeat(12_000), { maxLength: 10_000, maxLines: 2 }),
      "Keep the instructions under 10,000 characters.",
    );
    assert.deepEqual(instructionsTextLines("a\nb\nc", 2), ["a", "b"]);
  });

  test("the length check runs on the stored text, before the line count", () => {
    const text = `${"x".repeat(9)}\n${"y".repeat(9)}`;
    assert.equal(instructionsTextProblem(text, { maxLength: 19, maxLines: 1 }), "Keep it to 1 instructions or fewer, one per line.");
    assert.equal(instructionsTextProblem(text, { maxLength: 18, maxLines: 1 }), "Keep the instructions under 18 characters.");
  });
});
