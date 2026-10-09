import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Approval, Decision } from "../../lib/api.js";
import { decisionMatches, isStackReview, reviewMatches, stackLinkFromHash } from "./stackPage.js";

/**
 * Notifications, chat transcripts, and Ask AI answers all link a stack item as
 * `/decisions#decision-<id>` or `#review-<id>`; both stack pages read those
 * hashes, so the shape they accept is pinned here.
 */

const ID = "11111111-1111-4111-8111-111111111111";

function decision(changes: Partial<Decision> = {}): Decision {
  return {
    id: ID,
    companyId: "company",
    title: "Which customer update should we send?",
    body: "Acme asked about their delayed order.",
    summary: null,
    recommendation: null,
    options: [{ id: "send", label: "Send the update", detail: "Send it today.", tone: "primary" }],
    status: "decided",
    urgency: "normal",
    routineId: null,
    runId: null,
    conversationId: null,
    mailThreadId: null,
    source: { kind: "unknown", routine: null, run: null, conversation: null, mailThread: null },
    chosenOptionId: "send",
    chosenOptionLabel: "Send the update",
    note: "Mention the new delivery date.",
    decidedAt: null,
    decidedByUserId: "member",
    decidedBy: { id: "member", name: "Morgan" },
    decidedByEmployee: null,
    routedToEmployee: null,
    pickupStatus: "done",
    pickupSummary: "Sent the update to Priya.",
    pickupReport: null,
    pickupStartedAt: null,
    pickupFinishedAt: null,
    snoozedUntil: null,
    expiresAt: null,
    createdAt: "2026-09-09T12:00:00.000Z",
    employee: { id: "employee", name: "Alex Rivera", slug: "alex", avatarKey: null },
    assignee: null,
    ...changes,
  };
}

function approval(changes: Partial<Approval> = {}): Approval {
  return {
    id: ID,
    companyId: "company",
    kind: "mail_send",
    routineId: "routine",
    employeeId: "employee",
    title: "Reply to Acme",
    summary: null,
    errorMessage: null,
    status: "approved",
    requestedAt: "2026-09-09T12:00:00.000Z",
    decidedAt: null,
    decidedByUserId: null,
    routine: null,
    employee: { id: "employee", name: "Alex Rivera", slug: "alex" },
    ...changes,
  };
}

describe("stackLinkFromHash", () => {
  test("reads a Decision or review link, lower-casing its id", () => {
    assert.deepEqual(stackLinkFromHash(`#decision-${ID}`), { kind: "decision", id: ID });
    assert.deepEqual(stackLinkFromHash(`#review-${ID.toUpperCase()}`), { kind: "review", id: ID });
  });

  test("ignores anything that is not exactly one stack item", () => {
    for (const hash of [
      "",
      "#",
      `decision-${ID}`,
      "#decision-abc",
      `#decision-${ID}x`,
      `#reply-${ID}`,
    ]) {
      assert.equal(stackLinkFromHash(hash), null, hash);
    }
  });
});

describe("stack search", () => {
  test("finds a settled Decision by its outcome as well as its question", () => {
    const row = decision();
    for (const query of ["acme", "send the update", "delivery date", "priya", "morgan", "alex"]) {
      assert.equal(decisionMatches(row, query), true, query);
    }
    assert.equal(decisionMatches(row, "invoice"), false);
    assert.equal(decisionMatches(row, ""), true, "an empty search matches everything");
  });

  test("finds a Decision by the short lines its row shows and by its report", () => {
    const row = decision({
      summary: "Globex wants a three-year term at 10% off.",
      recommendation: "Sign it: the renewal is worth more than the discount.",
      pickupReport: "Countersigned the order form and filed it on the deal.",
    });
    for (const query of ["three-year term", "worth more than the discount", "countersigned"]) {
      assert.equal(decisionMatches(row, query), true, query);
    }
    assert.equal(decisionMatches(decision(), "countersigned"), false);
  });

  test("finds a review by its draft without reading other Approval kinds", () => {
    const row = approval({
      review: {
        kind: "mail",
        revision: "a",
        context: "Checkout fails on annual plans.",
        workSummary: "Prepared a fix.",
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
        draft: { to: "", cc: "", bcc: "", subject: "Re: Checkout", bodyText: "Hi Priya" },
      },
    });
    assert.equal(reviewMatches(row, "annual plans"), true);
    assert.equal(reviewMatches(row, "hi priya"), true);
    assert.equal(reviewMatches(row, "invoice"), false);
    assert.equal(isStackReview(row), true);
    assert.equal(isStackReview(approval({ kind: "proactive_work" })), true);
    assert.equal(isStackReview(approval({ kind: "routine" })), false);
  });
});
