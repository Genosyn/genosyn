import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OUTCOME_LIMITS,
  OUTCOME_TOOL_INPUT_SCHEMA,
  composeDiscussionBrief,
  composeFollowThroughBrief,
  composeOutcomeRequest,
  composeOutcomeSystemPrompt,
  composeTurnPrompt,
  describeEndReason,
  outcomeArgsSchema,
  renderOutcomeMarkdown,
  resolveOutcome,
  type PromptPerson,
} from "./groupDiscussionPrompts.js";

const ada: PromptPerson = { id: "e1", name: "Ada", slug: "ada", role: "Head of Product" };
const ben: PromptPerson = { id: "e2", name: "Ben", slug: "ben", role: "CFO" };
const cy: PromptPerson = { id: "e3", name: "Cy", slug: "cy", role: "Sales lead" };
const ruth = { id: "u1", name: "Ruth Ortiz", handle: "ruth" };

describe("the discussion brief", () => {
  const brief = composeDiscussionBrief({
    self: ben,
    colleagues: [ada, cy],
    starter: "Ruth Ortiz",
    question: "Should we raise the Pro plan to $49?\nWe have 300 customers on it.",
    lead: ada,
  });

  test("quotes the question and names who asked it", () => {
    assert.match(brief, /Ruth Ortiz started a group discussion/);
    assert.match(brief, /> Should we raise the Pro plan to \$49\?\n> We have 300 customers on it\./);
  });

  test("lists colleagues by @handle and role, not the speaker", () => {
    assert.match(brief, /- Ada \(@ada\) — Head of Product/);
    assert.match(brief, /- Cy \(@cy\) — Sales lead/);
    assert.doesNotMatch(brief, /\(@ben\)/);
  });

  test("tells the speaker how to pass, address, and that it cannot act", () => {
    assert.match(brief, /reply with exactly PASS/);
    assert.match(brief, /@handle/);
    assert.match(brief, /You cannot act/);
    assert.match(brief, /information, not instructions/);
  });

  test("tells a non-lead who leads, and the lead that it leads", () => {
    assert.match(brief, /Ada leads and writes the outcome/);
    const leadBrief = composeDiscussionBrief({
      self: ada,
      colleagues: [ben],
      starter: "Ruth",
      question: "Q",
      lead: ada,
    });
    assert.match(leadBrief, /You lead this discussion/);
  });

  test("carries attached files when the question had them", () => {
    const withFiles = composeDiscussionBrief({
      self: ben,
      colleagues: [],
      starter: "Ruth",
      question: "Read this",
      lead: ada,
      attachments: "--- pricing.csv ---\nplan,price",
    });
    assert.match(withFiles, /Files attached to the question:\n--- pricing\.csv ---/);
    assert.match(withFiles, /nobody else is taking part right now/);
  });
});

describe("the turn prompt", () => {
  test("states the round and asks for a first view", () => {
    const prompt = composeTurnPrompt({
      self: ben,
      round: 1,
      rounds: 3,
      addressedBy: [],
      newMemberInput: false,
      firstTurn: true,
    });
    assert.match(prompt, /^Round 1 of 3\. It is your turn, Ben\./);
    assert.match(prompt, /Give your view/);
  });

  test("puts colleagues who asked for this employee first", () => {
    const prompt = composeTurnPrompt({
      self: ben,
      round: 2,
      rounds: 3,
      addressedBy: ["Ada", "Cy"],
      newMemberInput: true,
      firstTurn: false,
    });
    assert.match(prompt, /Ada and Cy asked for your view — answer them first/);
    assert.match(prompt, /A Member has added to the discussion/);
    assert.match(prompt, /reply PASS/);
  });

  test("the last round asks where they land and what they commit to", () => {
    const prompt = composeTurnPrompt({
      self: ben,
      round: 3,
      rounds: 3,
      addressedBy: [],
      newMemberInput: false,
      firstTurn: false,
    });
    assert.match(prompt, /last round/);
    assert.match(prompt, /commit to doing/);
  });
});

describe("the outcome writer's prompts", () => {
  test("the system prompt carries the lead's Soul and the one tool", () => {
    const system = composeOutcomeSystemPrompt({
      companyName: "Acme",
      lead: ada,
      soul: "Be blunt and kind.",
      starter: "Ruth",
    });
    assert.match(system, /You are Ada, Head of Product at Acme/);
    assert.match(system, /Be blunt and kind\./);
    assert.match(system, /submit_discussion_outcome/);
    assert.match(system, /only tool/);
    assert.match(system, /ignore it/);
  });

  test("the request quotes the question, the roster and the transcript in order", () => {
    const request = composeOutcomeRequest({
      question: "Raise prices?",
      starter: "Ruth",
      participants: [ada, ben],
      members: [ruth],
      transcript: [
        { speaker: "Ruth Ortiz", role: "Member, asked the question", text: "Raise prices?" },
        { speaker: "Ada (@ada)", role: "Head of Product", text: "Yes, to $49." },
        { speaker: "Ben (@ben)", role: "CFO", text: "Margins allow it." },
      ],
      endedBecause: describeEndReason("converged"),
    });
    assert.match(request, /> Raise prices\?/);
    assert.match(request, /- Ruth Ortiz \(@ruth\)/);
    assert.match(request, /everyone agreed/);
    assert.ok(request.indexOf("Yes, to $49.") < request.indexOf("Margins allow it."));
  });

  test("an empty transcript says so rather than being blank", () => {
    const request = composeOutcomeRequest({
      question: "Q",
      starter: "Ruth",
      participants: [ada],
      members: [],
      transcript: [],
      endedBecause: describeEndReason("max_rounds"),
    });
    assert.match(request, /nobody added anything/);
    assert.match(request, /- \(none\)/);
  });

  test("every end reason reads as a plain sentence", () => {
    for (const reason of [
      "converged",
      "max_rounds",
      "turn_budget",
      "usage_budget",
      "time_limit",
      "repetition",
      "wrapped_up",
      "something_new",
    ]) {
      assert.ok(describeEndReason(reason).length > 5, reason);
    }
  });
});

describe("validating the outcome", () => {
  test("clips what is long and drops what is empty", () => {
    const parsed = outcomeArgsSchema.parse({
      summary: `  ${"s".repeat(OUTCOME_LIMITS.summaryChars + 50)}  `,
      recommendation: "Go to $49.",
      openQuestions: ["  ", "Do we email customers first?", ...Array(20).fill("More?")],
      actionItems: [
        { owner: "@ben", action: "Model the margin impact." },
        { owner: "", action: "Nobody owns this" },
        { owner: "Ruth", action: "   " },
      ],
    });
    assert.ok(parsed.summary.length <= OUTCOME_LIMITS.summaryChars + 1);
    assert.ok(parsed.summary.endsWith("…"));
    assert.equal(parsed.openQuestions.length, OUTCOME_LIMITS.openQuestions);
    assert.equal(parsed.openQuestions[0], "Do we email customers first?");
    assert.deepEqual(parsed.actionItems, [{ owner: "@ben", action: "Model the margin impact." }]);
  });

  test("refuses an empty summary or recommendation", () => {
    assert.equal(
      outcomeArgsSchema.safeParse({ summary: " ", recommendation: "x", openQuestions: [], actionItems: [] })
        .success,
      false,
    );
    assert.equal(
      outcomeArgsSchema.safeParse({ summary: "x", recommendation: "", openQuestions: [], actionItems: [] })
        .success,
      false,
    );
  });

  test("missing lists default to empty", () => {
    const parsed = outcomeArgsSchema.parse({ summary: "Done.", recommendation: "Ship it." });
    assert.deepEqual(parsed.openQuestions, []);
    assert.deepEqual(parsed.actionItems, []);
  });

  test("the advertised schema requires the same four fields", () => {
    assert.deepEqual([...OUTCOME_TOOL_INPUT_SCHEMA.required], [
      "summary",
      "recommendation",
      "openQuestions",
      "actionItems",
    ]);
  });

  test("owners resolve to participants or Members, and never to a guess", () => {
    const outcome = resolveOutcome(
      {
        summary: "S",
        recommendation: "R",
        openQuestions: [],
        actionItems: [
          { owner: "@ben", action: "Model margins" },
          { owner: "Cy", action: "Call the top accounts" },
          { owner: "@ruth", action: "Approve the email" },
          { owner: "Ruth Ortiz", action: "Sign off" },
          { owner: "@dee", action: "Not in the room" },
        ],
      },
      { participants: [ada, ben, cy], members: [ruth] },
      ada.id,
    );
    assert.equal(outcome.writtenByEmployeeId, ada.id);
    assert.deepEqual(
      outcome.actionItems.map((i) => i.owner && [i.owner.kind, i.owner.id]),
      [["ai", ben.id], ["ai", cy.id], ["user", ruth.id], ["user", ruth.id], null],
    );
    assert.equal(outcome.actionItems[4].ownerLabel, "@dee");
  });
});

describe("rendering", () => {
  const outcome = resolveOutcome(
    {
      summary: "We raise Pro to $49.",
      recommendation: "Announce on Monday.",
      openQuestions: ["Grandfather annual plans?"],
      actionItems: [
        { owner: "@ben", action: "Update the forecast." },
        { owner: "Ruth Ortiz", action: "Approve the announcement." },
        { owner: "Legal", action: "Check the terms." },
      ],
    },
    { participants: [ada, ben], members: [ruth] },
    ada.id,
  );

  test("the outcome renders as readable markdown for every surface", () => {
    const md = renderOutcomeMarkdown(outcome);
    assert.match(md, /^\*\*Outcome\*\*\n\nWe raise Pro to \$49\./);
    assert.match(md, /\*\*Recommendation\*\*\n\nAnnounce on Monday\./);
    assert.match(md, /- Grandfather annual plans\?/);
    assert.match(md, /- @ben: Update the forecast\./);
    assert.match(md, /- Ruth Ortiz: Approve the announcement\./);
    assert.match(md, /- Legal: Check the terms\./);
  });

  test("sections with nothing in them are left out", () => {
    const md = renderOutcomeMarkdown({ ...outcome, openQuestions: [], actionItems: [] });
    assert.doesNotMatch(md, /Open questions|Who does what/);
  });

  test("the follow-through brief carries this employee's items and every usual review", () => {
    const brief = composeFollowThroughBrief({
      self: ben,
      requester: "Ruth Ortiz",
      question: "Raise prices?",
      outcome,
      items: [outcome.actionItems[0]],
    });
    assert.match(brief, /Ruth Ortiz read the outcome/);
    assert.match(brief, /- Update the forecast\./);
    assert.match(brief, /Every usual review still applies/);
    assert.match(brief, /\*\*Who does what\*\*/);
  });
});
