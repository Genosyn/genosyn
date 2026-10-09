import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Approval, Decision } from "../../lib/api.js";
import {
  answeredBy,
  decisionStatusLine,
  groupHeading,
  groupStackItems,
  mailReviewStatusLine,
  workReviewStatusLine,
} from "./stackStatus.js";
import {
  compareStackItems,
  decisionItem,
  reviewItem,
  stackItemPending,
  stackItemWorking,
  type DecisionStackItem,
} from "./useDecisionFollowUps.js";

/**
 * Once a row is acted on it collapses to one status line, and the stack lays
 * its rows out for scanning. The wording is the product here — it is what
 * people read instead of a wall of text — so it is pinned exactly.
 */

const VIEWER = "viewer";
const LOG =
  "I found the deal and loaded BidNet Direct. Now I'll dismiss the cookie banner.\n\nRegistered on BidNet and saved the solicitation to the deal. Jamie owns it now.";

function decision(changes: Partial<Decision> = {}): Decision {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company",
    title: "Bid on the UTA tender?",
    body: "",
    summary: null,
    recommendation: null,
    options: [{ id: "bid", label: "Pursue: register and bid", detail: null, tone: "primary" }],
    status: "decided",
    urgency: "normal",
    routineId: null,
    runId: null,
    conversationId: null,
    mailThreadId: null,
    source: { kind: "unknown", routine: null, run: null, conversation: null, mailThread: null },
    chosenOptionId: "bid",
    chosenOptionLabel: "Pursue: register and bid",
    note: null,
    decidedAt: "2026-10-09T08:00:00.000Z",
    decidedByUserId: VIEWER,
    decidedBy: { id: VIEWER, name: "Morgan Lee" },
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
      revision: "a",
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
      draft: { to: " priya@acme.test ", cc: "", bcc: "", subject: "Re: Checkout", bodyText: "Hi" },
    },
    routine: null,
    employee: { id: "riley", name: "Riley Chen", slug: "riley" },
    ...changes,
  };
}

const line = (status: { label: string; text: string | null }) =>
  status.text ? `${status.label} · ${status.text}` : status.label;

describe("answeredBy", () => {
  test("names who answered as the viewer reads it", () => {
    assert.equal(answeredBy(decision(), VIEWER), "You");
    assert.equal(answeredBy(decision(), "someone-else"), "Morgan Lee");
    assert.equal(answeredBy(decision(), null), "Morgan Lee");
    assert.equal(
      answeredBy(
        decision({ decidedByEmployee: { id: "r", name: "Riley", slug: "riley" } }),
        VIEWER,
      ),
      "Riley (AI)",
    );
    assert.equal(
      answeredBy(decision({ decidedBy: null, decidedByUserId: null }), VIEWER),
      "Someone",
    );
  });
});

describe("decisionStatusLine for an answered Decision", () => {
  test("follows the work: waiting to start, on it, done", () => {
    assert.deepEqual(decisionStatusLine(decision(), VIEWER), {
      label: "You chose “Pursue: register and bid”",
      text: "Waiting for Jamie Mallers to start",
      tone: "progress",
      working: false,
    });
    assert.deepEqual(decisionStatusLine(decision({ pickupStatus: "running" }), VIEWER), {
      label: "You chose “Pursue: register and bid”",
      text: "Jamie Mallers is on it",
      tone: "progress",
      working: true,
    });
    assert.equal(
      line(
        decisionStatusLine(
          decision({
            pickupStatus: "done",
            pickupSummary: LOG,
            pickupReport: "Registered on BidNet. The bid is due Oct 8.",
          }),
          VIEWER,
        ),
      ),
      "Done · Registered on BidNet.",
    );
  });

  test("an older finished pickup reports its last paragraph's first sentence, never the narration", () => {
    const status = decisionStatusLine(
      decision({ pickupStatus: "done", pickupSummary: LOG }),
      VIEWER,
    );
    assert.equal(
      line(status),
      "Done · Registered on BidNet and saved the solicitation to the deal.",
    );
    assert.equal(status.tone, "success");
    assert.doesNotMatch(line(status), /cookie banner/);
  });

  test("a finished pickup with nothing to report still says it finished", () => {
    assert.equal(
      line(decisionStatusLine(decision({ pickupStatus: "done" }), VIEWER)),
      "Done · Jamie Mallers finished the work",
    );
  });

  test("a failed pickup says it could not finish, and why, in one line", () => {
    const status = decisionStatusLine(
      decision({
        pickupStatus: "failed",
        pickupSummary: "The billing portal rejected the card. Nothing was renewed.",
      }),
      VIEWER,
    );
    assert.deepEqual(status, {
      label: "Couldn’t finish",
      text: "The billing portal rejected the card.",
      tone: "warning",
      working: false,
    });
    assert.equal(
      line(decisionStatusLine(decision({ pickupStatus: "failed" }), VIEWER)),
      "Couldn’t finish · The work stopped before it finished.",
    );
  });

  test("a skipped pickup says the answer is saved", () => {
    assert.equal(
      line(
        decisionStatusLine(
          decision({
            pickupStatus: "skipped",
            pickupSummary:
              "This question came from work awaiting human review. Your answer is saved for the AI Employee.",
          }),
          VIEWER,
        ),
      ),
      "Answer saved · This question came from work awaiting human review.",
    );
    assert.equal(
      line(decisionStatusLine(decision({ pickupStatus: "skipped" }), VIEWER)),
      "Answer saved · Jamie Mallers reads it on their next run.",
    );
    // Quiet, but marked as an answer that was kept — not as a dismissal.
    assert.equal(decisionStatusLine(decision({ pickupStatus: "skipped" }), VIEWER).tone, "saved");
    assert.equal(decisionStatusLine(decision({ status: "cancelled" }), VIEWER).tone, "neutral");
  });

  test("names another Member, an AI decider, or an unknown chooser", () => {
    assert.match(decisionStatusLine(decision(), "someone-else").label, /^Morgan Lee chose /);
    assert.match(
      decisionStatusLine(
        decision({ decidedByEmployee: { id: "r", name: "Riley", slug: "riley" }, decidedBy: null }),
        VIEWER,
      ).label,
      /^Riley \(AI\) chose /,
    );
    assert.equal(
      decisionStatusLine(decision({ chosenOptionLabel: null, decidedBy: null }), VIEWER).label,
      "Someone chose “an answer”",
    );
    assert.equal(
      decisionStatusLine(decision({ employee: null, pickupStatus: "running" }), VIEWER).text,
      "The AI Employee is on it",
    );
  });

  test("a long report is cut to one short line, markdown read as text", () => {
    const status = decisionStatusLine(
      decision({ pickupStatus: "done", pickupReport: `**Done:** ${"registered ".repeat(40)}it.` }),
      VIEWER,
    );
    assert.ok((status.text ?? "").length <= 160, status.text ?? "");
    assert.ok(status.text?.startsWith("Done: registered"));
    assert.ok(status.text?.endsWith("…"));
  });
});

describe("decisionStatusLine for a Decision that was not answered", () => {
  test("dismissed by a Member, with their reason", () => {
    const dismissed = decision({ status: "cancelled", chosenOptionLabel: null });
    assert.deepEqual(decisionStatusLine(dismissed, VIEWER), {
      label: "Dismissed",
      text: "By you",
      tone: "neutral",
      working: false,
    });
    assert.equal(line(decisionStatusLine(dismissed, "other")), "Dismissed · By Morgan Lee");
    assert.equal(
      line(decisionStatusLine({ ...dismissed, note: "Handled on a call. Nothing to do." }, VIEWER)),
      "Dismissed · By you · Handled on a call.",
    );
    assert.equal(line(decisionStatusLine({ ...dismissed, decidedBy: null }, VIEWER)), "Dismissed");
  });

  test("withdrawn by its AI Employee", () => {
    const withdrawn = decision({ status: "cancelled", decidedByUserId: null, decidedBy: null });
    assert.equal(
      line(decisionStatusLine(withdrawn, VIEWER)),
      "Withdrawn · Jamie Mallers no longer needs an answer",
    );
    assert.equal(
      line(decisionStatusLine({ ...withdrawn, note: "The show was cancelled." }, VIEWER)),
      "Withdrawn · Jamie Mallers no longer needs an answer · The show was cancelled.",
    );
  });

  test("expired under an earlier version, and still waiting", () => {
    assert.equal(
      line(decisionStatusLine(decision({ status: "expired" }), VIEWER)),
      "Expired · This expired under an earlier version, before Decisions stopped expiring.",
    );
    assert.equal(
      decisionStatusLine(decision({ status: "pending" }), VIEWER).label,
      "Waiting for an answer",
    );
  });
});

describe("mailReviewStatusLine", () => {
  test("says what happened to the email, and to whom", () => {
    assert.equal(line(mailReviewStatusLine(approval())), "Waiting for review");
    assert.deepEqual(mailReviewStatusLine(approval({ status: "executing" })), {
      label: "Sending",
      text: "To priya@acme.test",
      tone: "progress",
      working: true,
    });
    assert.equal(
      line(
        mailReviewStatusLine(
          approval({
            status: "approved",
            mailOutcome: {
              sentMessageId: "m",
              providerMessageRef: "p",
              sentAt: "2026-10-09T08:00:00.000Z",
            },
          }),
        ),
      ),
      "Sent · To priya@acme.test",
    );
    assert.equal(
      line(mailReviewStatusLine(approval({ status: "rejected" }))),
      "Discarded · Nothing was sent.",
    );
    assert.equal(
      line(mailReviewStatusLine(approval({ status: "expired" }))),
      "Expired · Nothing was sent.",
    );
  });

  test("never calls an unconfirmed send sent", () => {
    const unconfirmed = mailReviewStatusLine(approval({ status: "approved", mailOutcome: null }));
    assert.equal(line(unconfirmed), "Send not confirmed · Check the source before sending again.");
    assert.equal(unconfirmed.tone, "warning");
    const failed = mailReviewStatusLine(
      approval({
        status: "execution_failed",
        mailDeliveryStatus: "unverified",
        errorMessage: "The provider timed out. It may have gone.",
      }),
    );
    assert.equal(line(failed), "Send not confirmed · The provider timed out.");
    assert.equal(
      line(
        mailReviewStatusLine(
          approval({ status: "execution_failed", mailDeliveryStatus: "unverified" }),
        ),
      ),
      "Send not confirmed · Check the source before sending again.",
    );
  });

  test("a known failure says it was not sent", () => {
    const notSent = mailReviewStatusLine(
      approval({
        status: "execution_failed",
        mailDeliveryStatus: "not_sent",
        errorMessage: "The mailbox refused it.",
      }),
    );
    assert.deepEqual(notSent, {
      label: "Not sent",
      text: "The mailbox refused it.",
      tone: "danger",
      working: false,
    });
    assert.equal(
      line(
        mailReviewStatusLine(
          approval({ status: "execution_failed", mailDeliveryStatus: "not_sent" }),
        ),
      ),
      "Not sent · The email was not sent.",
    );
  });

  test("a draft without a recipient says nothing about one", () => {
    const review = approval().review;
    assert.ok(review?.kind === "mail");
    assert.equal(
      mailReviewStatusLine(
        approval({
          status: "executing",
          review: { ...review, draft: { ...review.draft, to: "" } },
        }),
      ).text,
      null,
    );
    assert.equal(mailReviewStatusLine(approval({ status: "executing", review: null })).text, null);
  });
});

describe("workReviewStatusLine", () => {
  const work = (changes: Partial<Approval> = {}) =>
    approval({ kind: "proactive_work", review: null, ...changes });

  test("follows approved work to its reported outcome", () => {
    assert.equal(line(workReviewStatusLine(work())), "Waiting for review");
    assert.deepEqual(workReviewStatusLine(work({ status: "executing" })), {
      label: "Approved",
      text: "Riley Chen is doing the work",
      tone: "progress",
      working: true,
    });
    assert.equal(
      line(
        workReviewStatusLine(
          work({ status: "approved", outcomeSummary: "Fixed the bug. The Checks passed." }),
        ),
      ),
      "Done · Fixed the bug.",
    );
    assert.equal(
      line(workReviewStatusLine(work({ status: "approved", outcomeRunId: "run" }))),
      "Done · Open the Run for its report.",
    );
  });

  test("never calls unrecorded work done", () => {
    const status = workReviewStatusLine(work({ status: "approved" }));
    assert.equal(line(status), "Outcome not confirmed · No Run or report was recorded.");
    assert.equal(status.tone, "warning");
  });

  test("says when it could not finish, or did not start", () => {
    assert.equal(
      line(
        workReviewStatusLine(
          work({ status: "execution_failed", errorMessage: "Checks failed. See the Run." }),
        ),
      ),
      "Couldn’t finish · Checks failed.",
    );
    assert.equal(
      line(workReviewStatusLine(work({ status: "execution_failed" }))),
      "Couldn’t finish · The approved work could not finish.",
    );
    assert.equal(
      line(workReviewStatusLine(work({ status: "rejected" }))),
      "Declined · The work did not start.",
    );
    assert.equal(
      line(workReviewStatusLine(work({ status: "expired" }))),
      "Expired · The work did not start.",
    );
    assert.equal(
      workReviewStatusLine(work({ status: "executing", employee: null })).text,
      "The AI Employee is doing the work",
    );
  });
});

describe("groupStackItems", () => {
  const ask = (
    id: string,
    urgency: Decision["urgency"] = "normal",
    createdAt = "2026-10-09T07:00:00.000Z",
  ) => decisionItem(decision({ id, status: "pending", urgency, createdAt }));
  const mail = (id: string, requestedAt = "2026-10-09T07:30:00.000Z") =>
    reviewItem(approval({ id, requestedAt }));
  const work = (id: string) => reviewItem(approval({ id, kind: "proactive_work" }));
  const loading: DecisionStackItem = {
    kind: "loading",
    key: "review-loading",
    reference: { kind: "review", id: "loading" },
  };

  test("gathers email reviews under one heading where the first of them stands", () => {
    const entries = groupStackItems([
      ask("a"),
      mail("m1"),
      ask("b"),
      mail("m2"),
      work("w1"),
      mail("m3"),
    ]);
    assert.deepEqual(
      entries.map((entry) =>
        entry.kind === "item"
          ? entry.key
          : `${entry.key}:${entry.items.map((item) => item.key).join(",")}`,
      ),
      [
        "decision-a",
        "group-mail:review-m1,review-m2,review-m3",
        "decision-b",
        "group-work:review-w1",
      ],
    );
  });

  test("a single review still gets its group, so its row keeps its place in the tree", () => {
    const [entry] = groupStackItems([mail("m1")]);
    assert.equal(entry.kind, "group");
    assert.equal(entry.key, "group-mail");
    assert.equal(groupHeading("mail", entry.kind === "group" ? entry.items : []), null);
  });

  test("Decisions, loading placeholders and other Approval kinds are never grouped", () => {
    const routine = reviewItem(approval({ id: "r1", kind: "routine" }));
    const entries = groupStackItems([ask("a"), loading, routine]);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["item", "item", "item"],
    );
    assert.deepEqual(groupStackItems([]), []);
  });

  test("headings count what is still waiting", () => {
    const sent = reviewItem(
      approval({ id: "m1" }),
      approval({
        id: "m1",
        status: "approved",
        mailOutcome: {
          sentMessageId: "m",
          providerMessageRef: "p",
          sentAt: "2026-10-09T08:00:00.000Z",
        },
      }),
    );
    assert.equal(groupHeading("mail", [mail("m1"), mail("m2"), mail("m3")]), "3 emails to review");
    assert.equal(groupHeading("mail", [sent, mail("m2")]), "2 emails · 1 to review");
    assert.equal(groupHeading("work", [work("w1"), work("w2")]), "2 work plans to review");
    assert.equal(groupHeading("work", [work("w1")]), null);
  });
});

describe("stack order", () => {
  test("urgent questions first, then oldest; reviews rank with normal questions by age", () => {
    const items = [
      decisionItem(
        decision({
          id: "low",
          status: "pending",
          urgency: "low",
          createdAt: "2026-10-09T01:00:00.000Z",
        }),
      ),
      reviewItem(approval({ id: "mail", requestedAt: "2026-10-09T03:00:00.000Z" })),
      decisionItem(
        decision({ id: "late", status: "pending", createdAt: "2026-10-09T05:00:00.000Z" }),
      ),
      decisionItem(
        decision({
          id: "high",
          status: "pending",
          urgency: "high",
          createdAt: "2026-10-09T06:00:00.000Z",
        }),
      ),
      decisionItem(
        decision({ id: "early", status: "pending", createdAt: "2026-10-09T02:00:00.000Z" }),
      ),
    ];
    assert.deepEqual(
      [...items].sort(compareStackItems).map((item) => item.key),
      ["decision-high", "decision-early", "review-mail", "decision-late", "decision-low"],
    );
  });

  test("pending and working are told apart for the heading counts", () => {
    assert.equal(stackItemPending(decisionItem(decision({ status: "pending" }))), true);
    assert.equal(stackItemPending(decisionItem(decision())), false);
    assert.equal(stackItemWorking(decisionItem(decision({ pickupStatus: "running" }))), true);
    assert.equal(stackItemWorking(decisionItem(decision({ pickupStatus: "done" }))), false);
    assert.equal(stackItemPending(reviewItem(approval())), true);
    assert.equal(stackItemWorking(reviewItem(approval(), approval({ status: "executing" }))), true);
  });
});
