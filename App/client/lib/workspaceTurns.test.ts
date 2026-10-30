import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkspaceMessage, WorkspaceTurn } from "./workspace";
import {
  applyTurnUpdate,
  dropAnsweredTurns,
  replyTurnBadge,
  retryableTurnIds,
  stepsVisibilityNote,
  turnAccessFor,
  turnCardContext,
  typersWithoutTurns,
} from "./workspaceTurns";

/**
 * The room's picture of its AI turns: which are running, what each live card
 * says above its steps, what a reader is shown, and which failed replies can
 * be asked again.
 */

const ME = "user-me";

function turn(over: Partial<WorkspaceTurn> = {}): WorkspaceTurn {
  return {
    id: "t1",
    channelId: "c1",
    kind: "reply",
    status: "working",
    employee: { id: "ada", name: "Ada", slug: "ada", role: "Analyst" },
    triggerMessageId: "m1",
    discussionId: null,
    round: null,
    authority: "member",
    requester: { id: ME, name: "Me" },
    waitingFor: null,
    attempt: 1,
    startedAt: "2026-10-30T10:00:00.000Z",
    endedAt: null,
    replyMessageId: null,
    activity: null,
    ...over,
  };
}

function reply(over: Partial<WorkspaceMessage> & { turn?: Partial<WorkspaceTurn> }): WorkspaceMessage {
  const { turn: turnOver, ...rest } = over;
  const t = turn({ status: "ok", ...turnOver });
  return {
    id: `msg-${t.id}`,
    channelId: "c1",
    authorKind: "ai",
    author: { kind: "ai", id: t.employee!.id, name: t.employee!.name, slug: "ada", role: "Analyst" },
    content: "…",
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-10-30T10:01:00.000Z",
    attachments: [],
    reactions: [],
    aiTurn: {
      id: t.id,
      kind: t.kind,
      status: t.status,
      triggerMessageId: t.triggerMessageId,
      discussionId: t.discussionId,
      round: t.round,
      authority: t.authority,
      requester: t.requester,
      activity: t.activity,
    },
    ...rest,
  };
}

describe("the room's running turns", () => {
  test("a turn that starts joins the room in the order it was asked for", () => {
    const later = turn({ id: "t2", startedAt: "2026-10-30T10:05:00.000Z" });
    const earlier = turn({ id: "t1", startedAt: "2026-10-30T10:00:00.000Z" });
    const running = applyTurnUpdate(applyTurnUpdate([], later), earlier);
    assert.deepEqual(running.map((t) => t.id), ["t1", "t2"]);
  });

  test("a turn that starts waiting is updated in place; an unchanged one changes nothing", () => {
    const running = [turn()];
    assert.equal(applyTurnUpdate(running, turn()), running, "same identity, no render");
    const waiting = applyTurnUpdate(running, turn({ waitingFor: "model_unavailable" }));
    assert.notEqual(waiting, running);
    assert.equal(waiting[0].waitingFor, "model_unavailable");
  });

  test("a turn that ends leaves, whether its update or its reply arrives first", () => {
    const running = [turn(), turn({ id: "t2" })];
    assert.deepEqual(
      applyTurnUpdate(running, turn({ status: "ok" })).map((t) => t.id),
      ["t2"],
    );
    assert.deepEqual(
      dropAnsweredTurns(running, reply({ turn: { id: "t2" } })).map((t) => t.id),
      ["t1"],
    );
    assert.equal(dropAnsweredTurns(running, { aiTurn: null }), running);
    assert.equal(applyTurnUpdate([], turn({ status: "ok" })).length, 0);
  });
});

describe("what a reader is shown", () => {
  test("the asker sees every step; the rest of the room is told whose access hides the details", () => {
    assert.equal(turnAccessFor(turn(), ME), "full");
    assert.equal(stepsVisibilityNote("full", turn()), null);
    const sams = turn({ requester: { id: "sam", name: "Sam" } });
    assert.equal(turnAccessFor(sams, ME), "steps");
    assert.equal(
      stepsVisibilityNote("steps", sams),
      "It works with Sam’s access, so only Sam sees what each step read and returned.",
    );
  });

  test("an AI colleague's turn, and a webhook's, show every step to any Member", () => {
    assert.equal(turnAccessFor(turn({ authority: "employee", requester: null }), ME), "full");
    assert.equal(turnAccessFor(turn({ authority: "untrusted", requester: null }), ME), "full");
  });
});

describe("the line beside the name", () => {
  test("a reply says whose message it answers", () => {
    assert.equal(turnCardContext(turn(), { meId: ME }), "Replying to you");
    assert.equal(
      turnCardContext(turn({ requester: { id: "sam", name: "Sam" } }), { meId: ME }),
      "Replying to Sam",
    );
    assert.equal(
      turnCardContext(turn({ authority: "employee", requester: null }), { meId: ME }),
      "Replying to an AI colleague’s @mention",
    );
    assert.equal(
      turnCardContext(turn({ authority: "untrusted", requester: null }), { meId: ME }),
      "Replying to an incoming webhook message",
    );
    assert.equal(
      turnCardContext(turn({ attempt: 2 }), { meId: ME }),
      "Replying to you · picked up again",
    );
  });

  test("a discussion turn says which round it is", () => {
    assert.equal(
      turnCardContext(turn({ kind: "discussion", round: 2 }), { meId: ME, rounds: 3 }),
      "Round 2 of 3 · group discussion",
    );
    assert.equal(
      turnCardContext(turn({ kind: "discussion", round: 0 }), { meId: ME }),
      "Round 1 · group discussion",
    );
    assert.equal(
      turnCardContext(turn({ kind: "follow_through" }), { meId: ME }),
      "Doing its share of the outcome",
    );
  });
});

describe("asking a failed reply again", () => {
  test("only the newest failed reply to a message can be retried", () => {
    const first = reply({ turn: { id: "t1", status: "error" }, createdAt: "2026-10-30T10:01:00.000Z" });
    const second = reply({ turn: { id: "t2", status: "error" }, createdAt: "2026-10-30T10:02:00.000Z" });
    assert.deepEqual([...retryableTurnIds([first, second], [])], ["t2"]);
    const fixed = reply({ turn: { id: "t3", status: "ok" }, createdAt: "2026-10-30T10:03:00.000Z" });
    assert.deepEqual([...retryableTurnIds([first, second, fixed], [])], []);
  });

  test("not while that AI Employee is replying in the room, and never a stop or a discussion turn", () => {
    const failed = reply({ turn: { id: "t1", status: "skipped" } });
    assert.deepEqual([...retryableTurnIds([failed], [])], ["t1"]);
    assert.deepEqual([...retryableTurnIds([failed], [turn({ id: "t9" })])], []);
    assert.deepEqual(
      [...retryableTurnIds([reply({ turn: { id: "t2", status: "interrupted" } })], [])],
      [],
    );
    assert.deepEqual(
      [...retryableTurnIds([reply({ turn: { id: "t3", status: "error", kind: "discussion" } })], [])],
      [],
    );
  });

  test("each AI Employee's and each message's replies are their own", () => {
    const ada = reply({ turn: { id: "t1", status: "error" } });
    const ben = reply({
      turn: {
        id: "t2",
        status: "error",
        employee: { id: "ben", name: "Ben", slug: "ben", role: "CFO" },
      },
    });
    const other = reply({ turn: { id: "t3", status: "error", triggerMessageId: "m2" } });
    assert.deepEqual([...retryableTurnIds([ada, ben, other], [])].sort(), ["t1", "t2", "t3"]);
  });
});

describe("the rest of the room's chrome", () => {
  test("the typing pill leaves out an AI Employee whose card already shows it working", () => {
    const typers = [
      { kind: "ai" as const, id: "ada", name: "Ada" },
      { kind: "ai" as const, id: "ben", name: "Ben" },
      { kind: "user" as const, id: "sam", name: "Sam" },
    ];
    assert.deepEqual(
      typersWithoutTurns(typers, [turn()]).map((t) => t.id),
      ["ben", "sam"],
    );
    assert.equal(typersWithoutTurns(typers, []), typers);
  });

  test("a reply that did not simply answer says how it ended", () => {
    assert.deepEqual(replyTurnBadge({ status: "error" }), { tone: "danger", label: "Error" });
    assert.deepEqual(replyTurnBadge({ status: "skipped" }), {
      tone: "warning",
      label: "Not available",
    });
    assert.deepEqual(replyTurnBadge({ status: "interrupted" }), { tone: "neutral", label: "Stopped" });
    assert.equal(replyTurnBadge({ status: "ok" }), null);
    assert.equal(replyTurnBadge(null), null);
  });
});
