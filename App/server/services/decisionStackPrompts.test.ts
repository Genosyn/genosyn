import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import type { MailMessage } from "../db/entities/MailMessage.js";
import { DEFAULT_DECISION_STACK_INSTRUCTIONS } from "../../shared/decisionStackInstructions.js";
import { composeEmployeeSystemPrompt, toolsBriefing } from "./agent/systemPrompt.js";
import {
  DECISION_STACK_OFF_GUIDANCE,
  HUMAN_DECISION_GUIDANCE,
  decisionStackInstructionsGuidance,
} from "./humanDecisionGuidance.js";
import { composeHandoverPrompt } from "./mail/handoverPrompt.js";
import { MAX_WAITING_DECISIONS_PER_EMPLOYEE } from "./decisionDuplicates.js";
import { PROACTIVE_REVIEW_BRIEF, proactiveReviewBrief } from "./proactive/workReviewPolicy.js";
import { routineDeliveryMessage } from "./runner.js";

/**
 * Every briefing an AI Employee reads follows the Decision stack settings:
 * on, it carries the general guidance and the company's own instructions so
 * the employee can hold a question back before asking; off, it never promises
 * `request_decision`, says what to do instead, and keeps the email and work
 * reviews — Approvals, not Decisions — exactly as they were.
 */

const ON = { enabled: true, instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS };
const OFF = { enabled: false, instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS };
const REQUEST_DECISION_PROMISE = "`request_decision` for a major choice that needs human judgment";

describe("the off guidance", () => {
  test("says no new Decision can be raised, and what to do instead", () => {
    assert.match(DECISION_STACK_OFF_GUIDANCE, /turned the Decision stack off/);
    assert.match(DECISION_STACK_OFF_GUIDANCE, /`request_decision` is unavailable/);
    assert.match(
      DECISION_STACK_OFF_GUIDANCE,
      /any instruction in a Routine, Skill, Soul or handover to raise one no longer applies/,
    );
    assert.match(DECISION_STACK_OFF_GUIDANCE, /follow your instructions, Soul and company Policies/);
    assert.match(DECISION_STACK_OFF_GUIDANCE, /take only allowed steps you can easily undo/);
    assert.match(
      DECISION_STACK_OFF_GUIDANCE,
      /record open questions and blocked work in your Workstream or work report/,
    );
    assert.match(
      DECISION_STACK_OFF_GUIDANCE,
      /never take a consequential step you lack the authority for/,
    );
    assert.match(DECISION_STACK_OFF_GUIDANCE, /Decisions already waiting can still be answered/);
    assert.match(
      DECISION_STACK_OFF_GUIDANCE,
      /required Approvals, email reviews and work reviews still apply/,
    );
  });
});

describe("the company's instructions in a briefing", () => {
  test("are numbered the way the screen numbers them", () => {
    const text = decisionStackInstructionsGuidance("- Ask about contracts\n\n2) Never about labels");
    assert.match(text, /^Your company's Decision stack instructions, written by its owners and admins\./);
    assert.match(text, /check yours against them before you ask:/);
    assert.match(text, /\n {2}1\. Ask about contracts\n {2}2\. Never about labels$/);
  });

  test("say nothing at all when the company cleared them", () => {
    assert.equal(decisionStackInstructionsGuidance(""), "");
    assert.equal(decisionStackInstructionsGuidance("  \n\n "), "");
  });
});

describe("the chat and Routine tools briefing", () => {
  for (const surface of ["chat", "routine"] as const) {
    test(`${surface}, on: asks for fewer, bigger questions written for a busy owner`, () => {
      const briefing = toolsBriefing(surface, false, false, "write", ON);
      assert.match(briefing, /Ask one combined question rather than several small ones/);
      assert.match(briefing, /a question you already have waiting is refused/);
      assert.match(
        briefing,
        new RegExp(`you may have at most ${MAX_WAITING_DECISIONS_PER_EMPLOYEE} waiting at once`),
      );
      assert.match(briefing, /retract one with `cancel_decision`/);
      assert.match(briefing, /Write for a busy owner who is not an expert in your work/);
      assert.match(briefing, /the title is the question in plain words/);
      assert.match(briefing, /the summary says in one or two plain sentences/);
      assert.match(briefing, /the recommendation names the answer you recommend and why/);
      assert.match(briefing, /leave out IDs, codes and jargon/);
      assert.doesNotMatch(briefing, /Begin the body with/, "the body is now the optional detail");
      // Off, none of it is promised.
      const off = toolsBriefing(surface, false, false, "write", OFF);
      assert.doesNotMatch(off, /Ask one combined question/);
    });

    test(`${surface}, on: the general guidance, the company's instructions, then request_decision`, () => {
      const briefing = toolsBriefing(surface, false, false, "write", ON);
      assert.ok(briefing.includes(HUMAN_DECISION_GUIDANCE));
      const instructions = decisionStackInstructionsGuidance(DEFAULT_DECISION_STACK_INSTRUCTIONS);
      assert.ok(briefing.includes(instructions));
      for (const [index, line] of DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n").entries()) {
        assert.ok(briefing.includes(`${index + 1}. ${line}`), line);
      }
      assert.ok(briefing.includes(REQUEST_DECISION_PROMISE));
      assert.ok(
        briefing.indexOf(HUMAN_DECISION_GUIDANCE) < briefing.indexOf(instructions) &&
          briefing.indexOf(instructions) < briefing.indexOf(REQUEST_DECISION_PROMISE),
      );
      assert.doesNotMatch(briefing, /turned the Decision stack off/);
    });

    test(`${surface}, off: no request_decision promise, what to do instead, reviews kept`, () => {
      const briefing = toolsBriefing(surface, false, false, "write", OFF);
      assert.equal(briefing.includes(REQUEST_DECISION_PROMISE), false);
      assert.equal(briefing.includes(HUMAN_DECISION_GUIDANCE), false);
      assert.ok(briefing.includes(DECISION_STACK_OFF_GUIDANCE));
      // The company's instructions are not offered: there is nothing to screen.
      assert.equal(briefing.includes("Your company's Decision stack instructions"), false);
      // The only mention of request_decision says it is unavailable.
      const mentions = briefing.match(/request_decision/g) ?? [];
      assert.equal(mentions.length, 1);
      assert.match(briefing, /`request_decision` is unavailable/);
      // Email and work reviews are Approvals and stay.
      assert.match(briefing, /Use `request_work_review` for major proactive work/);
      assert.match(briefing, /`request_mail_review` for an exact customer email/);
      assert.match(briefing, /never create a Gmail or IMAP draft for the same reply/);
      assert.match(briefing, /`revise_work_review` or `revise_mail_review`/);
      assert.match(briefing, /does not expand your authority/);
    });
  }

  test("off in chat: the teammate in front of you can still be asked", () => {
    const briefing = toolsBriefing("chat", false, false, "write", OFF);
    assert.match(briefing, /In a live chat you can still ask the teammate in front of you\./);
    assert.doesNotMatch(briefing, /record what is blocked instead of guessing/);
  });

  test("off in a Routine: there is nobody to ask mid-run, so record what is blocked", () => {
    const briefing = toolsBriefing("routine", false, false, "write", OFF);
    assert.match(briefing, /record what is blocked instead of guessing/);
    // The progress checkpoint no longer points at a Decision either.
    assert.match(briefing, /blocked when access or a person's input is required/);
    assert.doesNotMatch(briefing, /a human Decision is required/);
  });

  test("on in a Routine: the checkpoint still names a human Decision", () => {
    const briefing = toolsBriefing("routine", false, false, "write", ON);
    assert.match(briefing, /blocked when access or a human Decision is required/);
  });

  test("on with the instructions cleared: guidance and request_decision, no empty block", () => {
    const briefing = toolsBriefing("routine", false, false, "write", {
      enabled: true,
      instructions: "",
    });
    assert.ok(briefing.includes(HUMAN_DECISION_GUIDANCE));
    assert.ok(briefing.includes(REQUEST_DECISION_PROMISE));
    assert.equal(briefing.includes("Your company's Decision stack instructions"), false);
  });

  test("callers that pass nothing get a company created today: on, default instructions", () => {
    assert.equal(
      toolsBriefing("routine", false, false),
      toolsBriefing("routine", false, false, "write", ON),
    );
  });
});

describe("the system prompt reads the switch off the Company row", () => {
  const employee = { name: "Ada", role: "Analyst", soulBody: "Be direct." } as AIEmployee;
  const compose = (co: Partial<Company>) =>
    composeEmployeeSystemPrompt({
      co: { id: "co-1", name: "Acme", mission: "", vision: "", ...co } as Company,
      emp: employee,
      skills: [],
      memoryContext: "",
      goalsContext: "",
      policiesContext: "",
      repositoriesContext: "",
      financeContext: "",
      signingContext: "",
      revenueContext: "",
      marketingContext: "",
      resourcesContext: "",
      routineAccess: "write",
      opening: "You are Ada.",
      surface: "routine",
      routineId: "routine-1",
      parallelDelegationAvailable: false,
      codingToolsAvailable: false,
    });

  test("a company created today: on, following the default instructions", () => {
    const prompt = compose({ decisionStackEnabled: true, decisionStackInstructions: null });
    assert.ok(prompt.includes(REQUEST_DECISION_PROMISE));
    assert.ok(prompt.includes(`1. ${DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n")[0]}`));
  });

  test("the company's own instructions replace the default", () => {
    const prompt = compose({ decisionStackInstructions: "Only ask about hiring." });
    assert.match(prompt, / {2}1\. Only ask about hiring\./);
    assert.equal(prompt.includes(DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n")[0]), false);
  });

  test("switched off, the prompt never promises request_decision", () => {
    const prompt = compose({ decisionStackEnabled: false, decisionStackInstructions: "Only ask about hiring." });
    assert.equal(prompt.includes(REQUEST_DECISION_PROMISE), false);
    assert.ok(prompt.includes(DECISION_STACK_OFF_GUIDANCE));
    assert.equal(prompt.includes("Only ask about hiring."), false);
  });

  test("the instructions sit in the trusted briefing, above the Soul", () => {
    const prompt = compose({ decisionStackInstructions: "Only ask about hiring." });
    assert.ok(prompt.indexOf("Only ask about hiring.") < prompt.indexOf("## Soul"));
  });
});

describe("the proactive review brief", () => {
  test("the stored copy reads exactly as it always has", () => {
    assert.ok(PROACTIVE_REVIEW_BRIEF.includes(HUMAN_DECISION_GUIDANCE));
    assert.match(
      PROACTIVE_REVIEW_BRIEF,
      /record or skip a minor unsupported step conservatively\. Use request_decision only for a major business choice that existing instructions cannot settle; answering one does not authorize restricted work\. If nothing actionable changed, finish quietly\./,
    );
    assert.equal(PROACTIVE_REVIEW_BRIEF, proactiveReviewBrief({ enabled: true, instructions: "" }));
  });

  test("on: the guidance, the company's instructions and request_decision", () => {
    const brief = proactiveReviewBrief(ON);
    assert.ok(brief.includes(HUMAN_DECISION_GUIDANCE));
    assert.ok(brief.includes(decisionStackInstructionsGuidance(DEFAULT_DECISION_STACK_INSTRUCTIONS)));
    assert.match(brief, /Use request_decision only for a major business choice/);
  });

  test("off: no request_decision, what to do instead, and every review kept", () => {
    const brief = proactiveReviewBrief(OFF);
    assert.ok(brief.includes(DECISION_STACK_OFF_GUIDANCE));
    assert.doesNotMatch(brief, /Use request_decision only/);
    assert.equal(brief.includes(HUMAN_DECISION_GUIDANCE), false);
    assert.match(brief, /Use request_mail_review with its exact subject and body/);
    assert.match(brief, /Use request_work_review only for substantive work/);
    assert.match(brief, /An owner or admin must approve that plan/);
    assert.match(brief, /record or skip a minor unsupported step conservatively\. If nothing actionable changed/);
    // The same preparation scope as always.
    assert.match(brief, /maintain factual Contact details/);
  });
});

describe("a Routine's mail delivery ceiling", () => {
  test("triage work records blockers in a Decision only while the stack is on", () => {
    const on = routineDeliveryMessage("Brief.", "triage", true);
    assert.match(on, /Record blockers in a Workstream or Decision\./);
    const off = routineDeliveryMessage("Brief.", "triage", false);
    assert.match(off, /Record blockers in a Workstream\. This server-enforced triage ceiling/);
    assert.doesNotMatch(off, /Decision\b(?! stack)/);
  });

  test("review, draft and reply ceilings are the same whichever way the switch is", () => {
    for (const mode of ["review", "draft", "reply"] as const) {
      assert.equal(
        routineDeliveryMessage("Brief.", mode, true),
        routineDeliveryMessage("Brief.", mode, false),
      );
    }
    assert.match(
      routineDeliveryMessage("Brief.", "review", false),
      /must use request_mail_review and return to the Decision stack/,
    );
  });

  test("no ceiling leaves the brief alone", () => {
    assert.equal(routineDeliveryMessage("Brief.", null, false), "Brief.");
    assert.equal(routineDeliveryMessage("Brief.", undefined, true), "Brief.");
  });
});

describe("the email handover prompt", () => {
  const handover = { sourceKind: "manual" as const, instruction: "Answer the customer.", mode: "work" as const };
  const account = { address: "owner@acme.example" };
  const thread = { id: "thread-1", subject: "Contract" };
  const messages: MailMessage[] = [];

  test("on (or unsaid): a Decision only for a material commitment", () => {
    for (const prompt of [
      composeHandoverPrompt(handover, account, thread, messages),
      composeHandoverPrompt(handover, account, thread, messages, { decisionStackEnabled: true }),
    ]) {
      assert.match(prompt, /request a Decision only for a material commercial commitment/);
    }
  });

  test("off: no Decision, the cautious way instead, reviews unchanged", () => {
    const prompt = composeHandoverPrompt(handover, account, thread, messages, {
      decisionStackEnabled: false,
    });
    assert.doesNotMatch(prompt, /request a Decision/);
    assert.match(prompt, /turned the Decision stack off, so do not raise a Decision/);
    assert.match(prompt, /never a consequential one you lack the authority for/);
    assert.match(prompt, /record open questions and blocked work in the Workstream/);
    assert.match(prompt, /put its exact content in the Decision stack with request_mail_review/);
  });
});
