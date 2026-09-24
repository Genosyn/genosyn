import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import type { MailReviewEvent, MailReviewSummary } from "../lib/mail.js";
import { MailReviewBadge } from "../components/mail/MailReviewBadge.js";
import { MailReviewTimeline } from "./MailReviewTimeline.js";

const review: MailReviewSummary = {
  status: "reviewed",
  latestMessageId: "message",
  employee: { id: "employee", name: "Jamie", slug: "jamie", avatarKey: null },
  updatedAt: "2026-09-24T10:00:00.000Z",
};
const event = (overrides: Partial<MailReviewEvent> = {}): MailReviewEvent => ({
  id: "event",
  kind: "received",
  occurredAt: "2026-09-24T10:00:00.000Z",
  title: "Email received",
  description: "A customer requested a quote.",
  employee: null,
  href: null,
  status: "complete",
  ...overrides,
});
const render = (overrides: Partial<React.ComponentProps<typeof MailReviewTimeline>> = {}) =>
  renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/" },
      React.createElement(MailReviewTimeline, {
        review,
        timeline: { events: [event()], truncated: false },
        companySlug: "acme",
        ...overrides,
      }),
    ),
  );

describe("AI review badges", () => {
  for (const status of [
    "not_reviewed",
    "queued",
    "reviewing",
    "reviewed",
    "needs_attention",
  ] as const) {
    test(`${status} is announced in words without relying on color or animation`, () => {
      const html = renderToStaticMarkup(
        React.createElement(MailReviewBadge, { review: { ...review, status }, compact: true }),
      );
      assert.match(html, /aria-label="[^"]+\. [^"]+"/);
      assert.match(html, new RegExp(`data-review-status="${status}"`));
      assert.match(html, /<svg[^>]+aria-hidden="true"/);
      assert.equal(html.includes("motion-safe:animate-spin"), status === "reviewing");
      assert.doesNotMatch(html, /role="button"|<button/);
    });
  }
  test("missing metadata remains unavailable rather than being reported reviewed", () => {
    const html = renderToStaticMarkup(React.createElement(MailReviewBadge));
    assert.match(html, /Review unavailable/);
    assert.doesNotMatch(html, />AI reviewed</);
  });
});

describe("email work timeline", () => {
  test("uses a named section, ordered history and machine-readable times", () => {
    const html = render();
    assert.match(html, /<section aria-labelledby=/);
    assert.match(html, /AI work timeline/);
    assert.match(html, /<ol aria-label="Email and AI work in chronological order"/);
    assert.match(html, /<time dateTime="2026-09-24T10:00:00\.000Z"/);
    assert.match(html, /aria-live="polite" aria-atomic="true"/);
  });
  test("shows receipt, review and actual results in server chronology with scoped destinations", () => {
    const events = [
      event(),
      event({
        id: "review",
        kind: "review_completed",
        title: "Reviewed the email",
        employee: review.employee,
      }),
      event({
        id: "quote",
        kind: "quote",
        title: "Created quote Q-1042",
        href: "/finance/estimates/quote-1",
      }),
      event({
        id: "decision",
        kind: "decision",
        title: "Added a Decision",
        href: "/decisions#decision-1",
      }),
      event({ id: "draft", kind: "draft", title: "Prepared a reply", href: "/decisions#reply-1" }),
    ];
    const html = render({ timeline: { events, truncated: false } });
    assert.ok(html.indexOf(">Email received<") < html.indexOf(">Reviewed the email<"));
    assert.ok(html.indexOf(">Reviewed the email<") < html.indexOf(">Created quote Q-1042<"));
    assert.match(html, /href="\/c\/acme\/finance\/estimates\/quote-1"/);
    assert.match(html, /href="\/c\/acme\/decisions#decision-1"/);
    assert.match(html, />Jamie</);
  });
  test("keeps long histories compact while exposing earlier activity", () => {
    const events = Array.from({ length: 9 }, (_, index) =>
      event({ id: String(index), title: `History event ${index}` }),
    );
    const html = render({ timeline: { events, truncated: true } });
    assert.match(html, /Show 3 earlier events/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /History event 0/);
    assert.match(html, /History event 3/);
    assert.match(html, /History event 8/);
    assert.match(html, /Showing the most recent recorded activity/);
  });
  test("never renders failure or pending work as a completed result", () => {
    const html = render({
      review: { ...review, status: "needs_attention" },
      timeline: {
        events: [
          event({
            kind: "review_failed",
            status: "failed",
            title: "Review could not finish",
            description: "The AI Model was unavailable.",
          }),
        ],
        truncated: false,
      },
    });
    assert.match(html, /Needs attention/);
    assert.match(html, /Review could not finish/);
    assert.match(html, /The AI Model was unavailable/);
    assert.doesNotMatch(html, />AI reviewed</);
  });
  test("gives unreviewed, queued and outbound-only conversations accurate empty explanations", () => {
    assert.match(
      render({
        review: { ...review, status: "not_reviewed" },
        timeline: { events: [], truncated: false },
      }),
      /latest incoming email has not been reviewed/,
    );
    assert.match(render({ review: { ...review, status: "queued" } }), /waiting for an AI Employee/);
    assert.match(
      render({ review: { ...review, status: "not_reviewed", latestMessageId: null } }),
      /no incoming email to review/,
    );
  });
  test("loading, error and empty activity are distinct visible states", () => {
    const loading = render({ timeline: null });
    assert.match(loading, /role="status"/);
    assert.match(loading, /Loading the timeline/);
    assert.doesNotMatch(loading, /No activity/);
    const failed = render({
      timeline: null,
      error: "Could not load the timeline.",
      onRetry: () => undefined,
    });
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Try again/);
    assert.doesNotMatch(failed, /Loading the timeline/);
    assert.match(
      render({ timeline: { events: [], truncated: false } }),
      /No activity has been recorded/,
    );
  });
  test("renders event text as text and refuses external action links", () => {
    const html = render({
      timeline: {
        events: [
          event({
            title: '<img src=x onerror="alert(1)">',
            description: "<script>unsafe()</script>",
            href: "https://outside.test",
          }),
        ],
        truncated: false,
      },
    });
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<img|<script|href="https:/);
  });
  test("an invalid timestamp does not create a broken time label", () => {
    const html = render({
      timeline: { events: [event({ occurredAt: "invalid" })], truncated: false },
    });
    assert.match(html, /Email received/);
    assert.doesNotMatch(html, /Invalid Date|<time/);
  });
});
