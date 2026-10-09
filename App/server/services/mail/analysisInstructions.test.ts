import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
  MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH,
  MAX_MAIL_ANALYSIS_INSTRUCTION_LINES,
  mailAnalysisInstructionLines,
  mailAnalysisInstructionsProblem,
  normalizeMailAnalysisInstructions,
  sameMailAnalysisInstructions,
} from "../../../shared/mailAnalysisInstructions.js";

/**
 * The instructions box's shared rules. The client and the server both run
 * these, so the box's Save button, the API's refusal, and the numbers the
 * model cites can never disagree — which is why the edge cases live here
 * rather than in either caller.
 */

describe("the default instructions", () => {
  test("cover both things the owner asked for, one per line", () => {
    const lines = mailAnalysisInstructionLines(DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /unsubscribe/i);
    assert.match(lines[0], /automatically/i);
    assert.match(lines[0], /marketing emails/i);
    assert.match(lines[1], /^Star/);
    assert.match(lines[1], /need my response/i);
    assert.match(lines[1], /important/i);
  });

  test("are already in the stored shape and within every limit", () => {
    assert.equal(
      normalizeMailAnalysisInstructions(DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS),
      DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
    );
    assert.equal(mailAnalysisInstructionsProblem(DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS), null);
  });
});

describe("normalizing what was typed", () => {
  test("makes every line ending a plain new line", () => {
    assert.equal(normalizeMailAnalysisInstructions("one\r\ntwo\rthree\nfour"), "one\ntwo\nthree\nfour");
  });

  test("drops trailing spaces from each line and blank lines from both ends", () => {
    assert.equal(
      normalizeMailAnalysisInstructions("\n\n  Star replies   \t\nArchive receipts  \n\n\n"),
      "  Star replies\nArchive receipts",
    );
  });

  test("keeps the words and the blank lines between instructions exactly as typed", () => {
    const text = "Star mail from Ana.\n\nArchive  receipts,   please.";
    assert.equal(normalizeMailAnalysisInstructions(text), text);
  });

  test("turns a box of only whitespace into nothing", () => {
    assert.equal(normalizeMailAnalysisInstructions("   \n\t\n  "), "");
    assert.equal(normalizeMailAnalysisInstructions(""), "");
  });
});

describe("splitting into numbered instructions", () => {
  test("gives one instruction per non-blank line, trimmed", () => {
    assert.deepEqual(mailAnalysisInstructionLines("  Star replies  \n\n\tArchive receipts\n"), [
      "Star replies",
      "Archive receipts",
    ]);
  });

  test("strips the list markers people type out of habit", () => {
    assert.deepEqual(
      mailAnalysisInstructionLines(
        "- Star replies\n* Archive receipts\n• Label invoices Finance\n– Mark newsletters read\n1. Unsubscribe from promos\n2) Star the boss\n— Archive alerts",
      ),
      [
        "Star replies",
        "Archive receipts",
        "Label invoices Finance",
        "Mark newsletters read",
        "Unsubscribe from promos",
        "Star the boss",
        "Archive alerts",
      ],
    );
  });

  test("leaves a leading number or dash that is part of the sentence", () => {
    assert.deepEqual(mailAnalysisInstructionLines("-5% coupons are spam\n1.5x invoices are urgent"), [
      "-5% coupons are spam",
      "1.5x invoices are urgent",
    ]);
  });

  test("drops a line that is only a list marker", () => {
    assert.deepEqual(mailAnalysisInstructionLines("- \nStar replies\n1. "), ["Star replies"]);
  });

  test("never returns more than the line limit, even for text saved some other way", () => {
    const text = Array.from({ length: 45 }, (_, index) => `Rule ${index + 1}`).join("\n");
    const lines = mailAnalysisInstructionLines(text);
    assert.equal(lines.length, MAX_MAIL_ANALYSIS_INSTRUCTION_LINES);
    assert.equal(lines[0], "Rule 1");
    assert.equal(lines.at(-1), `Rule ${MAX_MAIL_ANALYSIS_INSTRUCTION_LINES}`);
  });

  test("has nothing to number in an empty box", () => {
    assert.deepEqual(mailAnalysisInstructionLines(""), []);
    assert.deepEqual(mailAnalysisInstructionLines("\n \n"), []);
  });
});

describe("what cannot be saved", () => {
  test("accepts text right up to the length limit and refuses one character more", () => {
    assert.equal(
      mailAnalysisInstructionsProblem("a".repeat(MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH)),
      null,
    );
    assert.equal(
      mailAnalysisInstructionsProblem("a".repeat(MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH + 1)),
      "Keep the instructions under 4,000 characters.",
    );
  });

  test("measures the stored text, so trailing whitespace never pushes it over", () => {
    const text = `${"a".repeat(MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH)}   \n\n  `;
    assert.equal(mailAnalysisInstructionsProblem(text), null);
  });

  test("accepts the line limit and refuses one instruction more", () => {
    const at = Array.from({ length: MAX_MAIL_ANALYSIS_INSTRUCTION_LINES }, (_, i) => `Do ${i}`);
    assert.equal(mailAnalysisInstructionsProblem(at.join("\n")), null);
    assert.equal(
      mailAnalysisInstructionsProblem([...at, "One too many"].join("\n")),
      "Keep it to 30 instructions or fewer, one per line.",
    );
  });

  test("does not count blank lines or bare markers against the line limit", () => {
    const lines = Array.from({ length: MAX_MAIL_ANALYSIS_INSTRUCTION_LINES }, (_, i) => `Do ${i}`);
    assert.equal(mailAnalysisInstructionsProblem(lines.join("\n\n- \n")), null);
  });

  test("allows tabs and new lines but refuses other control characters", () => {
    assert.equal(mailAnalysisInstructionsProblem("Star\treplies\nArchive receipts"), null);
    for (const character of ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u000b"]) {
      assert.equal(
        mailAnalysisInstructionsProblem(`Star${character}replies`),
        "Instructions can only contain printable characters.",
        JSON.stringify(character),
      );
    }
    // Trailing whitespace of any kind is trimmed before the check, as it is
    // before saving, so a stray vertical tab at the end of a line is harmless.
    assert.equal(mailAnalysisInstructionsProblem("Star replies\u000b"), null);
  });

  test("accepts an empty box, which means no instructions", () => {
    assert.equal(mailAnalysisInstructionsProblem(""), null);
  });

  test("accepts words in any language and emoji", () => {
    assert.equal(mailAnalysisInstructionsProblem("Markiere wichtige E-Mails mit Stern ⭐\n星を付ける"), null);
  });
});

describe("telling whether the box changed", () => {
  test("treats line endings and trailing spaces as the same text", () => {
    assert.equal(sameMailAnalysisInstructions("Star replies\r\nArchive  ", "Star replies\nArchive"), true);
    assert.equal(sameMailAnalysisInstructions("\nStar replies\n", "Star replies"), true);
  });

  test("treats any change in the words as a change", () => {
    assert.equal(sameMailAnalysisInstructions("Star replies", "Star all replies"), false);
    assert.equal(sameMailAnalysisInstructions("Star replies", ""), false);
    assert.equal(sameMailAnalysisInstructions("A\nB", "B\nA"), false);
  });
});
