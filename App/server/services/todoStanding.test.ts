import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { todoStanding, type TodoStandingInput } from "../../shared/todoStanding.js";

/** A Todo says where it stands in one sentence, for every state a Todo can be in. */

const now = new Date(2026, 10, 5, 15, 0, 0); // A Thursday.
const casey = { kind: "ai" as const, name: "Casey" };
const base: TodoStandingInput = {
  status: "todo",
  assignee: casey,
  reviewerName: null,
  viewerIsReviewer: false,
  waitingOn: null,
  waitingSince: null,
  waitingCheckAt: null,
  workingSince: null,
  queued: false,
};
const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).toISOString();
const say = (changes: Partial<TodoStandingInput>) => todoStanding({ ...base, ...changes }, now);

describe("where a Todo stands", () => {
  test("someone working on it, and for how long", () => {
    const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();
    assert.equal(
      say({ status: "in_progress", workingSince: minutesAgo(3) }),
      "Casey is working on this. Started 3 minutes ago.",
    );
    assert.equal(
      say({ workingSince: minutesAgo(1) }),
      "Casey is working on this. Started 1 minute ago.",
    );
    assert.equal(say({ workingSince: minutesAgo(0) }), "Casey is working on this. Started just now.");
    assert.equal(say({ workingSince: minutesAgo(120) }), "Casey is working on this. Started 2 hours ago.");
  });

  test("waiting, since when, and when it checks back", () => {
    assert.equal(
      say({
        status: "in_progress",
        waitingOn: "customer",
        waitingSince: at(3),
        waitingCheckAt: at(6),
      }),
      "Waiting on the customer since Tuesday. Checks back tomorrow.",
    );
    assert.equal(
      say({ waitingOn: "member", waitingSince: at(5) }),
      "Waiting on a person since today.",
    );
    assert.equal(
      say({ waitingOn: "browser_approval", waitingSince: at(4) }),
      "Waiting for someone to approve a browser action since yesterday.",
    );
    assert.equal(
      say({ waitingOn: "work_session", waitingCheckAt: at(9) }),
      "Waiting on a work session. Checks back Monday.",
    );
    assert.equal(
      say({ waitingOn: "date", waitingSince: at(20, 9).replace("-11-", "-10-") }),
      "Waiting until a set date since 20 Oct.",
    );
  });

  test("finished", () => {
    assert.equal(say({ status: "done" }), "Finished. Casey's report is below.");
    assert.equal(say({ status: "done", assignee: { kind: "human", name: "Ruth" } }), "Finished.");
    assert.equal(say({ status: "done", assignee: null }), "Finished.");
    assert.equal(say({ status: "cancelled" }), "Cancelled.");
  });

  test("in review", () => {
    assert.equal(say({ status: "in_review", viewerIsReviewer: true }), "Needs your review.");
    assert.equal(say({ status: "in_review", reviewerName: "Ruth" }), "Waiting on Ruth's review.");
    assert.equal(say({ status: "in_review" }), "In review, with nobody set to review it.");
  });

  test("nobody's on it, and what would change that", () => {
    assert.equal(
      say({ assignee: null }),
      "Nobody's on this. Assign an AI Employee and it starts right away.",
    );
  });

  test("assigned, and not moving yet", () => {
    assert.equal(say({}), "Assigned to Casey, and not started yet.");
    assert.equal(say({ queued: true }), "Casey is queued to start on this.");
    assert.equal(say({ assignee: { kind: "human", name: "Ruth" } }), "Assigned to Ruth.");
  });

  test("what's happening now outranks what the card says", () => {
    assert.equal(
      say({ status: "in_review", workingSince: at(5, 14), viewerIsReviewer: true }),
      "Casey is working on this. Started 1 hour ago.",
    );
  });
});
