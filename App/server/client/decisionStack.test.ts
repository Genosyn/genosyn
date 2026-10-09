import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decisionStackInstructionsEdit,
  decisionStackOffBanner,
  decisionStackSwitchNote,
} from "../../client/lib/decisionStack.js";
import { instructionsEdit } from "../../client/lib/instructionsEdit.js";
import { analysisInstructionsEdit } from "../../client/lib/mailAnalysis.js";
import { DEFAULT_DECISION_STACK_INSTRUCTIONS } from "../../shared/decisionStackInstructions.js";
import { DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS } from "../../shared/mailAnalysisInstructions.js";

/**
 * What Decision stack → Settings and the stack's "off" banner say. Pure, so
 * the sentences a person reads before switching the stack off — what still
 * happens, what stops — are pinned here.
 */

describe("the instructions box", () => {
  const edit = (draft: string, saved = DEFAULT_DECISION_STACK_INSTRUCTIONS, usingDefault = true) =>
    decisionStackInstructionsEdit({ draft, saved, usingDefault });

  test("unchanged: nothing to save, and the default is not offered back to itself", () => {
    const state = edit(DEFAULT_DECISION_STACK_INSTRUCTIONS);
    assert.deepEqual(state, {
      dirty: false,
      problem: null,
      canSave: false,
      canRestore: false,
      countLabel: `${DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n").length} instructions`,
    });
  });

  test("trailing spaces and Windows line endings are not a change", () => {
    const state = edit(`${DEFAULT_DECISION_STACK_INSTRUCTIONS.replace(/\n/g, "\r\n")}   \n\n`);
    assert.equal(state.dirty, false);
    assert.equal(state.canSave, false);
  });

  test("a real edit can be saved, and is counted as the server counts it", () => {
    const state = edit(`${DEFAULT_DECISION_STACK_INSTRUCTIONS}\n- Ask us before hiring anyone.`);
    assert.equal(state.dirty, true);
    assert.equal(state.canSave, true);
    assert.equal(
      state.countLabel,
      `${DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n").length + 1} instructions`,
    );
  });

  test("one instruction is singular", () => {
    assert.equal(edit("Only ask about hiring.").countLabel, "1 instruction");
  });

  test("an emptied box says what it means here: every question goes on the stack", () => {
    const state = edit("");
    assert.equal(state.countLabel, "No instructions — every question goes on the stack");
    assert.equal(state.canSave, true);
    assert.equal(state.problem, null);
  });

  test("too many instructions or too much text cannot be saved, with the sentence why", () => {
    const many = edit(Array.from({ length: 31 }, (_, index) => `Rule ${index + 1}`).join("\n"));
    assert.equal(many.canSave, false);
    assert.equal(many.problem, "Keep it to 30 instructions or fewer, one per line.");
    const long = edit("a".repeat(4_001));
    assert.equal(long.canSave, false);
    assert.equal(long.problem, "Keep the instructions under 4,000 characters.");
  });

  test("Restore default is offered once the saved text is the company's own", () => {
    assert.equal(edit("x", "Only ask about hiring.", false).canRestore, true);
    assert.equal(edit("x", "", false).canRestore, true);
    assert.equal(edit("x").canRestore, false);
  });
});

describe("one rule set for both boxes", () => {
  test("the mailbox box is unchanged by sharing the rules", () => {
    assert.deepEqual(
      analysisInstructionsEdit({
        draft: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
        saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
        usingDefault: true,
      }),
      { dirty: false, problem: null, canSave: false, canRestore: false, countLabel: "2 instructions" },
    );
    assert.equal(
      analysisInstructionsEdit({ draft: "", saved: "x", usingDefault: false }).countLabel,
      "No instructions — new mail gets a summary and suggestions only",
    );
  });

  test("the generic helper takes each box's own limits and empty label", () => {
    const state = instructionsEdit({
      draft: "a\nb\nc",
      saved: "",
      usingDefault: false,
      limits: { maxLength: 100, maxLines: 2 },
      emptyLabel: "Nothing",
    });
    assert.equal(state.problem, "Keep it to 2 instructions or fewer, one per line.");
    assert.equal(state.canSave, false);
    assert.equal(state.countLabel, "2 instructions", "counted up to the cap, as the server reads it");
    assert.equal(
      instructionsEdit({
        draft: " ",
        saved: "x",
        usingDefault: false,
        limits: { maxLength: 100, maxLines: 2 },
        emptyLabel: "Nothing",
      }).countLabel,
      "Nothing",
    );
  });
});

describe("the note under the switch", () => {
  test("on says questions are checked against the instructions first", () => {
    assert.deepEqual(decisionStackSwitchNote({ enabled: true, pendingDecisions: 4 }), {
      tone: "ok",
      text: "On. AI Employees can bring you big decisions, and every new question is checked against your instructions first.",
    });
  });

  test("off says what stops and what does not, with no waiting questions", () => {
    const note = decisionStackSwitchNote({ enabled: false, pendingDecisions: 0 });
    assert.equal(note.tone, "off");
    assert.equal(
      note.text,
      "Off. AI Employees don't add new questions; they work within their instructions and Policies and note open questions in their work reports. Email and work reviews still arrive as usual.",
    );
  });

  test("off keeps the question already waiting answerable", () => {
    assert.match(
      decisionStackSwitchNote({ enabled: false, pendingDecisions: 1 }).text,
      /The question already waiting stays in the stack until someone answers or dismisses it\./,
    );
  });

  test("off keeps every question already waiting answerable", () => {
    assert.match(
      decisionStackSwitchNote({ enabled: false, pendingDecisions: 3 }).text,
      /The 3 questions already waiting stay in the stack until someone answers or dismisses them\./,
    );
  });
});

describe("the banner on the stack", () => {
  test("says new questions are paused and the rest still works", () => {
    const banner = decisionStackOffBanner({ canManage: true });
    assert.equal(banner.title, "The Decision stack is off");
    assert.match(banner.text, /aren't adding new questions/);
    assert.match(banner.text, /note open questions in their work reports/);
    assert.match(banner.text, /Questions already here can still be answered or dismissed/);
    assert.match(banner.text, /email and work reviews still arrive/);
  });

  test("offers owners and admins the way back on, and Members a look", () => {
    assert.equal(decisionStackOffBanner({ canManage: true }).link, "Turn it back on in Settings");
    assert.equal(decisionStackOffBanner({ canManage: false }).link, "See Settings");
  });
});
