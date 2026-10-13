import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Approval, Decision } from "../../lib/api.js";
import {
  bulkAnnouncement,
  bulkTarget,
  chunk,
  countTargets,
  dismissConfirmation,
  skippedSummary,
  toggleSelection,
} from "./stackBulk.js";
import { decisionItem, reviewItem } from "./useDecisionFollowUps.js";

/**
 * A selection on the Decision stack only takes rows off without acting on
 * them, and says exactly what it will do first. The wording is what a person
 * reads before discarding thirteen emails, so it is pinned exactly.
 */

function decision(changes: Partial<Decision> = {}): Decision {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company",
    title: "Bid on the UTA tender?",
    body: "",
    summary: null,
    recommendation: null,
    options: [{ id: "bid", label: "Pursue", detail: null, tone: "primary" }],
    status: "pending",
    urgency: "normal",
    routineId: null,
    runId: null,
    conversationId: null,
    mailThreadId: null,
    source: { kind: "unknown", routine: null, run: null, conversation: null, mailThread: null },
    chosenOptionId: null,
    chosenOptionLabel: null,
    note: null,
    decidedAt: null,
    decidedByUserId: null,
    decidedBy: null,
    decidedByEmployee: null,
    routedToEmployee: null,
    pickupStatus: "none",
    pickupSummary: null,
    pickupReport: null,
    pickupStartedAt: null,
    pickupFinishedAt: null,
    snoozedUntil: null,
    expiresAt: null,
    createdAt: "2026-10-09T07:00:00.000Z",
    employee: { id: "jamie", name: "Jamie Mallers", slug: "jamie", avatarKey: null },
    assignee: null,
    ...changes,
  };
}

function approval(changes: Partial<Approval> = {}): Approval {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: "company",
    kind: "mail_send",
    routineId: "routine",
    employeeId: "riley",
    title: "Reply to Priya",
    summary: null,
    errorMessage: null,
    status: "pending",
    requestedAt: "2026-10-09T07:00:00.000Z",
    decidedAt: null,
    decidedByUserId: null,
    review: {
      kind: "mail",
      revision: "a".repeat(64),
      context: "",
      workSummary: "",
      steps: [],
      attachments: [],
      source: {
        accountId: "mailbox",
        threadId: null,
        mailHandoverId: null,
        routineId: null,
        runId: null,
        conversationId: null,
      },
      draft: { to: "priya@acme.test", cc: "", bcc: "", subject: "Re: Checkout", bodyText: "Hi" },
    },
    routine: null,
    employee: { id: "riley", name: "Riley Chen", slug: "riley" },
    ...changes,
  };
}

describe("bulkTarget", () => {
  test("a waiting Decision, email or work plan can be selected, with its revision", () => {
    assert.deepEqual(bulkTarget(decisionItem(decision())), {
      kind: "decision",
      key: "decision-11111111-1111-4111-8111-111111111111",
      id: "11111111-1111-4111-8111-111111111111",
    });
    const email = approval();
    assert.deepEqual(bulkTarget(reviewItem(email, email)), {
      kind: "mail",
      key: "review-22222222-2222-4222-8222-222222222222",
      id: "22222222-2222-4222-8222-222222222222",
      reviewRevision: "a".repeat(64),
    });
    const plan = approval({ kind: "proactive_work", review: null });
    assert.deepEqual(bulkTarget(reviewItem(plan)), {
      kind: "work",
      key: "review-22222222-2222-4222-8222-222222222222",
      id: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("a row that only shows an outcome, or is still loading, cannot", () => {
    assert.equal(bulkTarget(decisionItem(decision({ status: "decided" }))), null);
    const sent = approval();
    assert.equal(bulkTarget(reviewItem(sent, { ...sent, status: "approved" })), null);
    assert.equal(
      bulkTarget({ kind: "loading", key: "decision-x", reference: { kind: "decision", id: "x" } }),
      null,
    );
    const other = approval({ kind: "browser_action" });
    assert.equal(bulkTarget(reviewItem(other)), null);
  });
});

describe("toggleSelection", () => {
  const order = ["a", "b", "c", "d", "e"];

  test("a click ticks or unticks one row", () => {
    assert.deepEqual([...toggleSelection(new Set(), order, "b", null, false)], ["b"]);
    assert.deepEqual([...toggleSelection(new Set(["b", "c"]), order, "b", "c", false)], ["c"]);
  });

  test("a shift-click gives the run from the last row ticked the clicked row's new state", () => {
    assert.deepEqual([...toggleSelection(new Set(["b"]), order, "e", "b", true)].sort(), [
      "b",
      "c",
      "d",
      "e",
    ]);
    assert.deepEqual([...toggleSelection(new Set(["b"]), order, "a", "d", true)].sort(), [
      "a",
      "b",
      "c",
      "d",
    ]);
    assert.deepEqual(
      [...toggleSelection(new Set(["a", "b", "c", "d"]), order, "c", "a", true)].sort(),
      ["d"],
    );
  });

  test("without a row to extend from, a shift-click is an ordinary click", () => {
    assert.deepEqual([...toggleSelection(new Set(), order, "c", null, true)], ["c"]);
    assert.deepEqual([...toggleSelection(new Set(), order, "c", "gone", true)], ["c"]);
  });
});

describe("dismissConfirmation", () => {
  test("Decisions alone need no confirmation: Undismiss brings them back", () => {
    assert.equal(dismissConfirmation({ decisions: 4, emails: 0, work: 0 }), null);
  });

  test("emails alone are discarded, by name", () => {
    assert.deepEqual(dismissConfirmation({ decisions: 0, emails: 13, work: 0 }), {
      title: "Discard 13 emails?",
      message:
        "13 emails are discarded and never sent. Each AI Employee is told. Discarded emails can’t be restored.",
      confirmLabel: "Discard 13 emails",
      variant: "danger",
    });
    assert.equal(
      dismissConfirmation({ decisions: 0, emails: 1, work: 0 })?.message,
      "1 email is discarded and never sent. Each AI Employee is told. Discarded emails can’t be restored.",
    );
  });

  test("work plans alone are declined", () => {
    assert.deepEqual(dismissConfirmation({ decisions: 0, emails: 0, work: 1 }), {
      title: "Decline 1 work plan?",
      message:
        "1 work plan is declined, and nothing in it is started. Each AI Employee is told. Declined plans can’t be restored.",
      confirmLabel: "Decline 1 work plan",
      variant: "danger",
    });
  });

  test("a mixed selection says what happens to each kind", () => {
    assert.deepEqual(dismissConfirmation({ decisions: 1, emails: 13, work: 2 }), {
      title: "Dismiss 16 items?",
      message:
        "1 decision is dismissed without an answer. Undismiss in Decision history brings it back. 13 emails are discarded and never sent. 2 work plans are declined, and nothing in them is started. Each AI Employee is told. Discarded emails and declined plans can’t be restored.",
      confirmLabel: "Dismiss 16 items",
      variant: "danger",
    });
    assert.equal(
      dismissConfirmation({ decisions: 2, emails: 1, work: 0 })?.title,
      "Dismiss 3 items?",
    );
  });
});

describe("bulkAnnouncement", () => {
  test("names what happened to each kind", () => {
    assert.equal(
      bulkAnnouncement({ action: "dismiss" }, { decisions: 3, emails: 13, work: 1 }),
      "3 decisions dismissed, 13 emails discarded and 1 work plan declined. They are in Decision history.",
    );
    assert.equal(
      bulkAnnouncement({ action: "dismiss" }, { decisions: 1, emails: 0, work: 0 }),
      "1 decision dismissed. They are in Decision history.",
    );
    assert.equal(
      bulkAnnouncement({ action: "snooze", label: "1 week" }, { decisions: 2, emails: 0, work: 0 }),
      "2 decisions snoozed for 1 week.",
    );
  });
});

describe("skippedSummary", () => {
  test("names each reason once, with how often it applied", () => {
    assert.deepEqual(
      skippedSummary(
        [
          { reason: "Already answered" },
          { reason: "Assigned to another teammate" },
          { reason: "Already answered" },
        ],
        "dismiss",
        11,
      ),
      {
        title: "3 items weren’t dismissed",
        message:
          "Already answered (2); Assigned to another teammate (1). The other 11 were dismissed.",
      },
    );
  });

  test("a single skip reads plainly, and says when nothing else changed", () => {
    assert.deepEqual(skippedSummary([{ reason: "Already dismissed" }], "snooze", 0), {
      title: "1 item wasn’t snoozed",
      message: "Already dismissed.",
    });
    assert.deepEqual(skippedSummary([{ reason: "Expired" }], "dismiss", 1), {
      title: "1 item wasn’t dismissed",
      message: "Expired. The other one was dismissed.",
    });
  });
});

describe("countTargets and chunk", () => {
  test("count each kind and split long selections", () => {
    assert.deepEqual(
      countTargets([
        { kind: "decision", key: "d", id: "d" },
        { kind: "mail", key: "m1", id: "m1" },
        { kind: "mail", key: "m2", id: "m2" },
        { kind: "work", key: "w", id: "w" },
      ]),
      { decisions: 1, emails: 2, work: 1 },
    );
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 100), []);
  });
});
