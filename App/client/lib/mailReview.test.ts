import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MailAnalysis, MailReviewSummary, MailThread } from "./mail.js";
import {
  currentMailAnalysis,
  mailReviewDescription,
  mailReviewHref,
  mailReviewLabel,
  mergeMailThreadUpdate,
} from "./mailReview.js";

const review: MailReviewSummary = {
  status: "reviewed",
  latestMessageId: "latest-message",
  employee: { id: "employee", name: "Jamie", slug: "jamie", avatarKey: null },
  updatedAt: "2026-09-24T10:00:00.000Z",
};

describe("mail review wording", () => {
  for (const [status, label] of [
    ["not_reviewed", "Not reviewed"],
    ["queued", "AI queued"],
    ["reviewing", "AI reviewing"],
    ["reviewed", "AI reviewed"],
    ["needs_attention", "Needs attention"],
  ] as const) {
    test(`${status} has its own visible state`, () => {
      assert.equal(mailReviewLabel({ ...review, status }), label);
      assert.ok(mailReviewDescription({ ...review, status }).length > label.length);
    });
  }
  test("an unavailable projection does not claim the email was unreviewed", () => {
    assert.equal(mailReviewLabel(), "Review unavailable");
    assert.match(mailReviewDescription(), /could not be loaded/);
  });
  test("explains that read status is about the newest inbound message", () => {
    assert.equal(
      mailReviewDescription({ ...review, status: "reviewing" }),
      "Jamie is reviewing the latest incoming email.",
    );
    assert.match(mailReviewDescription(review), /Jamie reviewed the latest incoming email/);
    assert.match(mailReviewDescription({ ...review, employee: null }), /^An AI Employee reviewed/);
  });
  test("outbound-only conversations do not imply a missed incoming review", () => {
    assert.equal(
      mailReviewDescription({ ...review, status: "not_reviewed", latestMessageId: null }),
      "There is no incoming email to review in this conversation.",
    );
  });
});

describe("mail review evidence survives mailbox actions", () => {
  const current = {
    id: "thread",
    subject: "Quote",
    unread: true,
    labelIds: ["INBOX"],
    aiReview: review,
  } as MailThread;
  test("keeps the projection when a star/read/label response omits it", () => {
    const updated = { ...current, unread: false, labelIds: ["INBOX", "STARRED"] };
    delete updated.aiReview;
    const result = mergeMailThreadUpdate(current, updated);
    assert.equal(result.aiReview, review);
    assert.equal(result.unread, false);
    assert.deepEqual(result.labelIds, ["INBOX", "STARRED"]);
    assert.equal(current.unread, true);
  });
  test("accepts a new incoming email's reset projection", () => {
    const nextReview = { ...review, status: "not_reviewed" as const, latestMessageId: "new-reply" };
    assert.equal(
      mergeMailThreadUpdate(current, { ...current, aiReview: nextReview }).aiReview,
      nextReview,
    );
  });
  test("a response for a different thread cannot replace the selected one", () => {
    assert.equal(mergeMailThreadUpdate(current, { ...current, id: "previous-thread" }), current);
  });
});

describe("only the current incoming email's analysis is actionable", () => {
  const analysis = (id: string, messageId: string) =>
    ({ id, messageId, status: "succeeded" }) as MailAnalysis;
  test("does not show a previous message's summary after a new reply arrives", () => {
    assert.equal(currentMailAnalysis([analysis("old", "old-message")], review), null);
  });
  test("chooses the most recent matching analysis and leaves the source array untouched", () => {
    const rows = [
      analysis("first", "latest-message"),
      analysis("retry", "latest-message"),
      analysis("other", "old-message"),
    ];
    assert.equal(currentMailAnalysis(rows, review)?.id, "retry");
    assert.equal(rows[0].id, "first");
  });
  test("does not infer a current review from missing metadata or outbound-only mail", () => {
    const rows = [analysis("review", "latest-message")];
    assert.equal(currentMailAnalysis(rows), null);
    assert.equal(currentMailAnalysis(rows, { ...review, latestMessageId: null }), null);
    assert.equal(currentMailAnalysis([], review), null);
  });
});

describe("timeline links remain inside the current company", () => {
  test("links to a concrete resource or Decision stack anchor", () => {
    assert.equal(
      mailReviewHref("acme", "/finance/estimates/quote-id"),
      "/c/acme/finance/estimates/quote-id",
    );
    assert.equal(mailReviewHref("acme", "/decisions#decision-id"), "/c/acme/decisions#decision-id");
    assert.equal(mailReviewHref("a/b", "/decisions"), "/c/a%2Fb/decisions");
  });
  for (const href of [
    null,
    "",
    "https://outside.test",
    "//outside.test",
    "javascript:alert(1)",
    "decisions",
    "/../outside",
    "/./outside",
    "/%2e%2e/outside",
    "/%2Foutside",
    "/%5coutside",
    "/\\outside",
    "/\noutside",
  ]) {
    test(`rejects ${JSON.stringify(href)}`, () => assert.equal(mailReviewHref("acme", href), null));
  }
});
