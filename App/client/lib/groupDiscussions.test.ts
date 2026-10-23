import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  GROUP_CHAT_LIMITS,
  actionItemOwnerLabel,
  actionItemStatusLabel,
  assignableItems,
  canFinish,
  canStartWork,
  canStop,
  composerPlaceholder,
  discussionStatusLine,
  discussionsByOutcomeMessage,
  endReasonLabel,
  formatTokens,
  groupChatDraftProblem,
  groupChatTitle,
  listNames,
  mergeDiscussion,
  participantStateLabel,
  runningDiscussion,
  suggestGroupChatName,
  togglePick,
  usageLabel,
} from "./groupDiscussions";
import type { GroupDiscussion, WorkspaceChannel } from "./workspace";

/**
 * The status bar, the outcome card and the start dialog read everything they
 * show through these functions — so these tests are what keeps "round 2 of 3
 * · Ben is thinking…" true to the discussion it describes.
 */

const ME = "u-me";

function discussion(overrides: Partial<GroupDiscussion> = {}): GroupDiscussion {
  return {
    id: "d1",
    channelId: "c1",
    status: "running",
    phase: "discussing",
    endReason: null,
    endDetail: null,
    question: "Should we raise prices?",
    questionMessageId: "m1",
    startedBy: { id: ME, name: "Ruth" },
    leadEmployeeId: "ada",
    participants: [
      { id: "ada", name: "Ada", slug: "ada", role: "Product", avatarKey: null, state: "spoke" },
      { id: "ben", name: "Ben", slug: "ben", role: "CFO", avatarKey: null, state: "speaking" },
    ],
    round: 2,
    rounds: 3,
    turnsTaken: 3,
    maxTurns: 10,
    tokensUsed: 0,
    tokenBudget: 800_000,
    currentEmployeeId: "ben",
    passes: [],
    skipped: [],
    outcome: null,
    outcomeMessageId: null,
    followThrough: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:05:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

const concluded = (overrides: Partial<GroupDiscussion> = {}) =>
  discussion({
    status: "concluded",
    phase: "done",
    endReason: "converged",
    currentEmployeeId: null,
    outcomeMessageId: "m9",
    outcome: {
      summary: "Raise to $49.",
      recommendation: "Announce Monday.",
      openQuestions: [],
      actionItems: [
        { owner: { kind: "ai", id: "ben", name: "Ben", slug: "ben" }, ownerLabel: "@ben", action: "Update forecast" },
        { owner: { kind: "user", id: ME, name: "Ruth" }, ownerLabel: "Ruth", action: "Approve" },
        { owner: null, ownerLabel: "@legal", action: "Check terms" },
      ],
      writtenByEmployeeId: "ada",
    },
    updatedAt: "2026-10-23T10:09:00.000Z",
    ...overrides,
  });

describe("folding updates", () => {
  test("adds new discussions newest first", () => {
    const older = discussion({ id: "a", createdAt: "2026-10-23T09:00:00.000Z" });
    const newer = discussion({ id: "b", createdAt: "2026-10-23T11:00:00.000Z" });
    assert.deepEqual(
      mergeDiscussion(mergeDiscussion([], older), newer).map((d) => d.id),
      ["b", "a"],
    );
  });

  test("replaces in place with a fresher copy", () => {
    const list = [discussion()];
    const next = mergeDiscussion(list, discussion({ round: 3, updatedAt: "2026-10-23T10:06:00.000Z" }));
    assert.equal(next[0].round, 3);
  });

  test("ignores a frame that is older than what is held", () => {
    const list = [discussion({ round: 3, updatedAt: "2026-10-23T10:06:00.000Z" })];
    assert.equal(mergeDiscussion(list, discussion({ round: 2 })), list);
  });

  test("a late 'running' frame never repaints a discussion that ended", () => {
    const list = [concluded()];
    const stale = discussion({ updatedAt: "2026-10-23T10:10:00.000Z" });
    assert.equal(mergeDiscussion(list, stale), list);
  });

  test("finds the running one and each outcome's discussion", () => {
    const list = [discussion({ id: "live" }), concluded({ id: "done", outcomeMessageId: "m9" })];
    assert.equal(runningDiscussion(list)?.id, "live");
    assert.equal(runningDiscussion([concluded()]), null);
    assert.equal(discussionsByOutcomeMessage(list).get("m9")?.id, "done");
  });
});

describe("the status line", () => {
  test("names the round and who is thinking", () => {
    assert.equal(discussionStatusLine(discussion()), "Discussing · round 2 of 3 · Ben is thinking…");
  });

  test("between turns it still says where it is", () => {
    assert.equal(
      discussionStatusLine(discussion({ currentEmployeeId: null, round: 0 })),
      "Discussing · round 1 of 3",
    );
  });

  test("says who is writing the outcome", () => {
    assert.equal(
      discussionStatusLine(discussion({ phase: "concluding", currentEmployeeId: "ada" })),
      "Ada is writing the outcome…",
    );
  });

  test("ended discussions say why", () => {
    assert.equal(discussionStatusLine(concluded()), "Concluded · everyone agreed");
    assert.equal(
      discussionStatusLine(discussion({ status: "stopped", endDetail: "Stopped by Sam." })),
      "Stopped by Sam.",
    );
    assert.equal(discussionStatusLine(discussion({ status: "failed" })), "Ended without an outcome");
    assert.equal(discussionStatusLine(discussion({ status: "interrupted" })), "Interrupted by a restart");
  });

  test("every end reason and participant state has words", () => {
    for (const reason of [
      "converged",
      "max_rounds",
      "turn_budget",
      "usage_budget",
      "time_limit",
      "repetition",
      "wrapped_up",
      "stopped",
      "standdown",
      "access_changed",
      "channel_archived",
      "no_participants",
      "restart",
      "error",
      null,
    ] as const) {
      assert.ok(endReasonLabel(reason).length > 2, String(reason));
    }
    for (const state of ["waiting", "speaking", "spoke", "passed", "skipped", "benched", "writing"] as const) {
      assert.ok(participantStateLabel(state).length > 2, state);
    }
  });
});

describe("controls", () => {
  test("Stop while running; Finish only while turns are being taken", () => {
    assert.equal(canStop(discussion()), true);
    assert.equal(canFinish(discussion()), true);
    assert.equal(canFinish(discussion({ phase: "concluding" })), false);
    assert.equal(canStop(concluded()), false);
    assert.equal(canFinish(concluded()), false);
  });

  test("Start the work needs an outcome with AI Employees in the discussion to do it", () => {
    assert.equal(canStartWork(concluded()), true);
    assert.deepEqual(assignableItems(concluded()).map((i) => i.action), ["Update forecast"]);
    assert.equal(
      canStartWork(concluded({ followThrough: { startedAt: "x", byUserId: ME } })),
      false,
      "only once",
    );
    assert.equal(canStartWork(discussion()), false);
    const outsider = concluded({
      outcome: {
        ...concluded().outcome!,
        actionItems: [
          { owner: { kind: "ai", id: "dee", name: "Dee", slug: "dee" }, ownerLabel: "@dee", action: "x" },
        ],
      },
    });
    assert.equal(canStartWork(outsider), false, "an owner outside the discussion is not dispatched");
  });

  test("owners and statuses read plainly", () => {
    const items = concluded().outcome!.actionItems;
    assert.deepEqual(items.map(actionItemOwnerLabel), ["Ben", "Ruth", "legal"]);
    assert.equal(actionItemStatusLabel("done"), "Done");
    assert.equal(actionItemStatusLabel("failed"), "Couldn't finish");
    assert.equal(actionItemStatusLabel(undefined), null);
  });

  test("the cost guard is visible", () => {
    assert.equal(usageLabel({ turnsTaken: 3, maxTurns: 10, tokensUsed: 0 }), "Turn 4 of 10");
    assert.equal(usageLabel({ turnsTaken: 10, maxTurns: 10, tokensUsed: 210_400 }), "Turn 10 of 10 · 210k tokens");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1_500_000), "1.5M");
    assert.equal(formatTokens(2_000_000), "2M");
  });
});

describe("group chats", () => {
  const channel = (overrides: Partial<WorkspaceChannel>): Pick<WorkspaceChannel, "name" | "members"> => ({
    name: null,
    members: [
      { kind: "user", id: ME, name: "Ruth", email: null },
      { kind: "user", id: "u2", name: "Sam", email: null },
      { kind: "ai", id: "ada", name: "Ada", slug: "ada", role: "Product" },
      { kind: "ai", id: "ben", name: "Ben", slug: "ben", role: "CFO" },
    ],
    ...overrides,
  });

  test("a named chat is its name", () => {
    assert.equal(groupChatTitle(channel({ name: " Pricing " }), ME), "Pricing");
  });

  test("an unnamed one is the others in it, AI Employees first, never you", () => {
    assert.equal(groupChatTitle(channel({}), ME), "Ada, Ben, Sam");
  });

  test("a crowd is shortened", () => {
    const many = channel({});
    many.members.push(
      { kind: "ai", id: "cy", name: "Cy", slug: "cy", role: "R" },
      { kind: "ai", id: "dee", name: "Dee", slug: "dee", role: "R" },
    );
    assert.equal(groupChatTitle(many, ME), "Ada, Ben, Cy +2");
  });

  test("nobody else reads as a group chat", () => {
    assert.equal(groupChatTitle({ name: null, members: [] }, ME), "Group chat");
  });

  test("the suggested name is the question's first line, cut at a word", () => {
    assert.equal(suggestGroupChatName("## Q3 pricing\nmore"), "Q3 pricing");
    const long = suggestGroupChatName(
      "Should we move the whole support team to a follow-the-sun rota before the APAC launch?",
    );
    assert.ok(long.endsWith("…") && long.length <= 61);
    assert.equal(suggestGroupChatName("  "), "");
  });

  test("the first one picked leads, and order survives toggling others", () => {
    let picked: string[] = [];
    picked = togglePick(picked, "ben");
    picked = togglePick(picked, "ada");
    picked = togglePick(picked, "cy");
    picked = togglePick(picked, "ada");
    assert.deepEqual(picked, ["ben", "cy"]);
  });

  test("a draft says what is missing", () => {
    const base = { employeeIds: ["a", "b"], question: "", name: "", questionRequired: false };
    assert.equal(groupChatDraftProblem(base), null, "a question is optional for a new group chat");
    assert.match(groupChatDraftProblem({ ...base, employeeIds: ["a"] }) ?? "", /at least 2/);
    assert.match(
      groupChatDraftProblem({ ...base, employeeIds: ["a", "b", "c", "d", "e", "f", "g"] }) ?? "",
      /at most 6/,
    );
    assert.match(groupChatDraftProblem({ ...base, questionRequired: true }) ?? "", /what they should work out/);
    assert.match(
      groupChatDraftProblem({ ...base, question: "x".repeat(GROUP_CHAT_LIMITS.maxQuestionChars + 1) }) ?? "",
      /under 8,000/,
    );
    assert.match(groupChatDraftProblem({ ...base, name: "n".repeat(81) }) ?? "", /under 80/);
  });

  test("the composer invites the right thing", () => {
    assert.match(composerPlaceholder("group", ["Ada", "Ben"], discussion()) ?? "", /Add to the discussion/);
    assert.equal(
      composerPlaceholder("group", ["Ada", "Ben", "Cy"], null),
      "Ask Ada, Ben and Cy to work something out",
    );
    assert.equal(composerPlaceholder("group", [], null), null, "a group chat of people only");
    assert.equal(composerPlaceholder("public", ["Ada"], null), null);
    assert.match(composerPlaceholder("public", ["Ada"], discussion()) ?? "", /Add to the discussion/);
  });

  test("names list the way people say them", () => {
    assert.equal(listNames([]), "");
    assert.equal(listNames(["Ada"]), "Ada");
    assert.equal(listNames(["Ada", "Ben"]), "Ada and Ben");
    assert.equal(listNames(["Ada", "Ben", "Cy"]), "Ada, Ben and Cy");
    assert.equal(listNames(["Ada", "Ben", "Cy", "Dee", "Eve"]), "Ada, Ben and 3 others");
  });
});
