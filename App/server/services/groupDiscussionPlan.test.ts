import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  GROUP_DISCUSSION_LIMITS,
  REPEAT_THRESHOLD,
  benchParticipant,
  budgetStop,
  clampRounds,
  classifyMentions,
  completeRound,
  emptyDiscussionState,
  markInputSeen,
  maxTurnsFor,
  mentionedHandles,
  noteMemberInput,
  parseDiscussionState,
  parseParticipants,
  pickNextSpeaker,
  readTurn,
  recordTurn,
  similarity,
  type DiscussionState,
} from "./groupDiscussionPlan.js";

/**
 * The rules a group discussion is driven by — turn order, what counts as
 * adding nothing, and when the talk ends. The service persists what these
 * return and decides nothing about order or termination on its own, so these
 * tests are the specification of both.
 */

const ADA = "ada";
const BEN = "ben";
const CY = "cy";
const ROSTER = [ADA, BEN, CY];

function afterTurns(
  turns: Array<{ speaker: string; kind?: Parameters<typeof recordTurn>[1]["kind"]; addressed?: string[] }>,
  round = 1,
  start: DiscussionState = emptyDiscussionState(),
): DiscussionState {
  return turns.reduce(
    (state, turn) =>
      recordTurn(state, {
        speaker: turn.speaker,
        round,
        kind: turn.kind ?? "spoke",
        addressed: turn.addressed,
      }),
    start,
  );
}

describe("turn order", () => {
  test("the lead opens and the roster follows in order", () => {
    let state = emptyDiscussionState();
    const order: string[] = [];
    for (;;) {
      const next = pickNextSpeaker(ROSTER, state);
      if (!next) break;
      order.push(next);
      state = recordTurn(state, { speaker: next, round: 1, kind: "spoke" });
    }
    assert.deepEqual(order, [ADA, BEN, CY]);
  });

  test("someone addressed by @handle speaks before the others still waiting", () => {
    const state = afterTurns([{ speaker: ADA, addressed: [CY] }]);
    assert.equal(pickNextSpeaker(ROSTER, state), CY);
    const afterCy = recordTurn(state, { speaker: CY, round: 1, kind: "spoke" });
    assert.equal(pickNextSpeaker(ROSTER, afterCy), BEN);
  });

  test("several addressed speak in the order they were named", () => {
    const state = afterTurns([{ speaker: ADA, addressed: [CY, BEN] }]);
    assert.deepEqual(state.queue, [CY, BEN]);
    assert.equal(pickNextSpeaker(ROSTER, state), CY);
  });

  test("addressing someone who already spoke this round has them open the next", () => {
    const state = afterTurns([{ speaker: ADA }, { speaker: BEN }, { speaker: CY, addressed: [BEN] }]);
    assert.equal(pickNextSpeaker(ROSTER, state), null, "the round is over");
    assert.deepEqual(state.carry, [BEN]);
    const decision = completeRound(state, 1, 3);
    assert.equal(decision.next, "continue");
    assert.equal(pickNextSpeaker(ROSTER, decision.state), BEN, "Ben opens round two");
  });

  test("addressing yourself changes nothing", () => {
    const state = afterTurns([{ speaker: ADA, addressed: [ADA] }]);
    assert.deepEqual(state.queue, []);
    assert.deepEqual(state.carry, []);
    assert.equal(pickNextSpeaker(ROSTER, state), BEN);
  });

  test("a pass cannot address anyone — nobody would read it", () => {
    const state = afterTurns([{ speaker: ADA, kind: "pass", addressed: [CY] }]);
    assert.deepEqual(state.queue, []);
    assert.equal(pickNextSpeaker(ROSTER, state), BEN);
  });

  test("an unavailable participant is passed over without being marked as spoken", () => {
    const state = emptyDiscussionState();
    assert.equal(pickNextSpeaker(ROSTER, state, new Set([ADA])), BEN);
    assert.deepEqual(state.spoken, [], "Ada can still speak this round once she is back");
    assert.equal(pickNextSpeaker(ROSTER, state), ADA);
  });

  test("a benched participant never speaks again", () => {
    const state = benchParticipant(emptyDiscussionState(), ADA);
    assert.equal(pickNextSpeaker(ROSTER, state), BEN);
    const reset = completeRound(afterTurns([{ speaker: BEN }, { speaker: CY }], 1, state), 1, 3);
    assert.equal(pickNextSpeaker(ROSTER, reset.state), BEN);
    assert.equal(benchParticipant(state, ADA), state, "benching twice is a no-op");
  });

  test("an addressed participant who is unavailable does not block the queue", () => {
    const state = afterTurns([{ speaker: ADA, addressed: [CY] }]);
    assert.equal(pickNextSpeaker(ROSTER, state, new Set([CY])), BEN);
  });

  test("nobody left to speak ends the round", () => {
    assert.equal(pickNextSpeaker([], emptyDiscussionState()), null);
    assert.equal(pickNextSpeaker(ROSTER, emptyDiscussionState(), new Set(ROSTER)), null);
  });
});

describe("recording turns", () => {
  test("a skip records why and counts as the turn", () => {
    const state = recordTurn(emptyDiscussionState(), {
      speaker: BEN,
      round: 2,
      kind: "skipped",
      skip: { reason: "standdown", detail: "Audit in progress" },
    });
    assert.deepEqual(state.spoken, [BEN]);
    assert.deepEqual(state.skipped, [
      { employeeId: BEN, round: 2, reason: "standdown", detail: "Audit in progress" },
    ]);
    assert.equal(state.roundHadContent, false);
  });

  test("passes, agreement and repeats are recorded with their reason", () => {
    const state = afterTurns(
      [
        { speaker: ADA, kind: "pass" },
        { speaker: BEN, kind: "agree" },
        { speaker: CY, kind: "repeat" },
      ],
      2,
    );
    assert.deepEqual(
      state.passes.map((p) => [p.employeeId, p.reason, p.round]),
      [
        [ADA, "pass", 2],
        [BEN, "agree", 2],
        [CY, "repeat", 2],
      ],
    );
    assert.equal(state.roundHadContent, false);
    assert.equal(state.roundHadRepeat, true);
  });

  test("recording does not mutate the state it was given", () => {
    const before = emptyDiscussionState();
    recordTurn(before, { speaker: ADA, round: 1, kind: "spoke", addressed: [BEN] });
    assert.deepEqual(before, emptyDiscussionState());
  });
});

describe("ending a round", () => {
  test("a round with content continues while rounds remain", () => {
    const decision = completeRound(afterTurns([{ speaker: ADA }]), 1, 3);
    assert.equal(decision.next, "continue");
    assert.deepEqual(decision.state.spoken, []);
    assert.equal(decision.state.roundHadContent, false);
  });

  test("the last round ends it", () => {
    const decision = completeRound(afterTurns([{ speaker: ADA }]), 3, 3);
    assert.deepEqual([decision.next, decision.next === "end" && decision.reason], ["end", "max_rounds"]);
  });

  test("a quiet round ends it as converged, however many rounds remain", () => {
    const state = afterTurns([
      { speaker: ADA, kind: "pass" },
      { speaker: BEN, kind: "agree" },
      { speaker: CY, kind: "pass" },
    ]);
    const decision = completeRound(state, 1, 5);
    assert.deepEqual([decision.next, decision.next === "end" && decision.reason], ["end", "converged"]);
  });

  test("a round of repeats ends it as repetition", () => {
    const state = afterTurns([
      { speaker: ADA, kind: "repeat" },
      { speaker: BEN, kind: "pass" },
      { speaker: CY, kind: "repeat" },
    ]);
    const decision = completeRound(state, 2, 5);
    assert.deepEqual([decision.next, decision.next === "end" && decision.reason], ["end", "repetition"]);
  });

  test("a round where everyone sat out converges rather than spinning", () => {
    let state = emptyDiscussionState();
    for (const id of ROSTER) {
      state = recordTurn(state, { speaker: id, round: 1, kind: "skipped", skip: { reason: "error" } });
    }
    assert.equal(completeRound(state, 1, 3).next, "end");
  });
});

describe("Member input mid-discussion", () => {
  test("counts as content, so the round cannot converge on it", () => {
    const state = noteMemberInput(emptyDiscussionState(), 1, 3);
    assert.equal(state.roundHadContent, true);
    assert.equal(state.extraRounds, 0, "an early round needs no extra one");
  });

  test("in the last round it buys one more round", () => {
    const state = noteMemberInput(emptyDiscussionState(), 3, 3);
    assert.equal(state.extraRounds, 1);
    assert.equal(completeRound(state, 3, 3).next, "continue");
  });

  test("never more than the cap, however much is written", () => {
    let state = emptyDiscussionState();
    let round = 3;
    for (let i = 0; i < 10; i += 1) {
      state = noteMemberInput(state, round, 3);
      round = 3 + state.extraRounds;
    }
    assert.equal(state.extraRounds, GROUP_DISCUSSION_LIMITS.maxExtraRounds);
  });

  test("an input is folded in once", () => {
    const once = markInputSeen(emptyDiscussionState(), "m1");
    assert.equal(markInputSeen(once, "m1"), once);
    assert.deepEqual(markInputSeen(once, "m2").inputsSeen, ["m1", "m2"]);
  });
});

describe("budgets", () => {
  const startedAt = new Date("2026-10-23T10:00:00Z");
  const base = { turnsTaken: 0, maxTurns: 10, tokensUsed: 0, tokenBudget: 1_000, startedAt, now: startedAt };

  test("nothing spent, nothing stops", () => {
    assert.equal(budgetStop(base), null);
  });

  test("the turn ceiling", () => {
    assert.equal(budgetStop({ ...base, turnsTaken: 10 }), "turn_budget");
    assert.equal(budgetStop({ ...base, turnsTaken: 9 }), null);
  });

  test("the usage budget keeps a reserve for the outcome", () => {
    const reserveLine = 1_000 * (1 - GROUP_DISCUSSION_LIMITS.outcomeReserveRatio);
    assert.equal(budgetStop({ ...base, tokensUsed: reserveLine }), "usage_budget");
    assert.equal(budgetStop({ ...base, tokensUsed: reserveLine - 1 }), null);
  });

  test("a zero budget means unmetered, not stopped", () => {
    assert.equal(budgetStop({ ...base, tokenBudget: 0, tokensUsed: 5_000 }), null);
  });

  test("the wall clock", () => {
    const late = new Date(startedAt.getTime() + GROUP_DISCUSSION_LIMITS.discussionTimeoutMs);
    assert.equal(budgetStop({ ...base, now: late }), "time_limit");
  });

  test("turn ceilings scale with the roster and are capped", () => {
    assert.equal(maxTurnsFor(3, 3), 3 * (3 + GROUP_DISCUSSION_LIMITS.maxExtraRounds));
    assert.equal(maxTurnsFor(6, 5), GROUP_DISCUSSION_LIMITS.maxTurnsCeiling);
    assert.equal(maxTurnsFor(0, 3), 3 + GROUP_DISCUSSION_LIMITS.maxExtraRounds);
  });

  test("rounds are clamped to what a discussion allows", () => {
    assert.equal(clampRounds(undefined), GROUP_DISCUSSION_LIMITS.defaultRounds);
    assert.equal(clampRounds(0), 1);
    assert.equal(clampRounds(99), GROUP_DISCUSSION_LIMITS.maxRounds);
    assert.equal(clampRounds(2.6), 3);
    assert.equal(clampRounds(Number.NaN), GROUP_DISCUSSION_LIMITS.defaultRounds);
  });
});

describe("reading a turn", () => {
  test("PASS in its many dresses", () => {
    for (const reply of ["PASS", "pass", "[PASS]", "Pass.", "**PASS**", "  PASS  ", ""]) {
      assert.equal(readTurn(reply, []).kind, "pass", JSON.stringify(reply));
    }
  });

  test("a capitalised PASS with a short reason still passes", () => {
    assert.equal(readTurn("PASS — I agree with Ben's numbers.", []).kind, "pass");
  });

  test("a turn that opens with the verb is content", () => {
    const reading = readTurn("Pass the budget to finance first, then we decide on hiring.", []);
    assert.equal(reading.kind, "spoke");
  });

  test("agreement with nothing added is not content", () => {
    for (const reply of [
      "Agreed.",
      "I agree with Ben's plan.",
      "Sounds good to me",
      "+1",
      "Nothing to add.",
      "No objections.",
      "Works for me.",
    ]) {
      assert.equal(readTurn(reply, []).kind, "agree", reply);
    }
  });

  test("agreement that adds a number, a caveat or a question is content", () => {
    for (const reply of [
      "Agreed, at $49 a month.",
      "I agree, but the EU launch needs legal review.",
      "Sounds good — when do we tell customers?",
      "Agreed; we should also email the top ten accounts.",
      "I disagree.",
      "I don't agree with that at all.",
    ]) {
      assert.equal(readTurn(reply, []).kind, "spoke", reply);
    }
  });

  test("a close restatement of an earlier message is a repeat", () => {
    const earlier =
      "Raise the Pro plan to $49 and grandfather existing customers for six months so churn stays flat.";
    const again =
      "Raise the Pro plan to $49 and grandfather existing customers for six months, so churn stays flat.";
    const reading = readTurn(again, [earlier]);
    assert.equal(reading.kind, "repeat");
  });

  test("a new point on the same topic is not a repeat", () => {
    const earlier = "Raise the Pro plan to $49 and grandfather existing customers for six months.";
    const reply = "Finance can absorb the grandfathering: the six months cost us about $12k in total.";
    assert.equal(readTurn(reply, [earlier]).kind, "spoke");
  });

  test("an overlong turn is clipped, and says so", () => {
    const reply = "word ".repeat(GROUP_DISCUSSION_LIMITS.maxTurnChars);
    const reading = readTurn(reply, []);
    assert.equal(reading.kind, "spoke");
    if (reading.kind !== "spoke") return;
    assert.equal(reading.clipped, true);
    assert.ok(reading.text.length <= GROUP_DISCUSSION_LIMITS.maxTurnChars + 1);
    assert.ok(reading.text.endsWith("…"));
  });

  test("similarity is symmetric, 1 for the same text and low for unrelated text", () => {
    const a = "We should hire a second support engineer before the launch.";
    const b = "The quarterly report shows revenue grew twelve percent.";
    assert.equal(similarity(a, a), 1);
    assert.equal(similarity(a, b), similarity(b, a));
    assert.ok(similarity(a, b) < REPEAT_THRESHOLD);
    assert.equal(similarity("Yes", "yes!"), 1);
  });
});

describe("mentions", () => {
  const participants = [
    { id: ADA, slug: "ada" },
    { id: BEN, slug: "ben-cfo" },
  ];
  const company = [...participants, { id: CY, slug: "cy" }, { id: "dee", slug: "dee" }];

  test("handles are read in order, once each, case-folded", () => {
    assert.deepEqual(mentionedHandles("@Ben-CFO and @ada, then @ben-cfo again (@cy)"), [
      "ben-cfo",
      "ada",
      "cy",
    ]);
  });

  test("an email address is not a mention", () => {
    assert.deepEqual(mentionedHandles("write to ops@example.com"), []);
  });

  test("participants are addressed; company AI Employees outside are brought in", () => {
    const { addressed, outsiders } = classifyMentions(
      "@ben-cfo can you check this? Maybe @dee knows. @nobody?",
      participants,
      company,
    );
    assert.deepEqual(addressed, [BEN]);
    assert.deepEqual(outsiders, ["dee"]);
  });
});

describe("persisted state", () => {
  test("round-trips through JSON", () => {
    const state = markInputSeen(
      benchParticipant(afterTurns([{ speaker: ADA, addressed: [CY] }, { speaker: BEN, kind: "pass" }]), CY),
      "msg-1",
    );
    assert.deepEqual(parseDiscussionState(JSON.stringify(state)), state);
  });

  test("garbage and older shapes read as a usable state", () => {
    assert.deepEqual(parseDiscussionState(null), emptyDiscussionState());
    assert.deepEqual(parseDiscussionState("not json"), emptyDiscussionState());
    assert.deepEqual(parseDiscussionState("[1,2]").spoken, []);
    const old = parseDiscussionState(JSON.stringify({ spoken: [ADA, 7], extraRounds: 99 }));
    assert.deepEqual(old.spoken, [ADA]);
    assert.equal(old.extraRounds, GROUP_DISCUSSION_LIMITS.maxExtraRounds);
    assert.deepEqual(old.inputsSeen, []);
  });

  test("participants parse defensively and de-duplicate", () => {
    assert.deepEqual(parseParticipants(JSON.stringify([ADA, BEN, ADA, "", 3])), [ADA, BEN]);
    assert.deepEqual(parseParticipants("{}"), []);
    assert.deepEqual(parseParticipants(null), []);
  });
});
