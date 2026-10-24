import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, CountBadge, badgeClassName, type BadgeProps, type BadgeTone } from "./Badge.js";

// `createElement` does not count children passed as arguments toward a
// required `children` prop, so type the props as optional here.
const BadgeAny = Badge as React.ComponentType<Partial<BadgeProps>>;
const render = (props: Partial<BadgeProps>, ...children: React.ReactNode[]) =>
  renderToStaticMarkup(React.createElement(BadgeAny, props, ...children));

const TONES: BadgeTone[] = ["neutral", "accent", "success", "warning", "danger", "info", "ai"];

describe("Badge", () => {
  test("reads in sentence case without changing its text", () => {
    const html = render({ tone: "success" }, "completed");
    // The DOM keeps the API's value — tests and screen readers see "completed".
    assert.match(html, />completed</);
    // The first letter is shown upper-case by CSS.
    assert.match(html, /first-letter:uppercase/);
    assert.doesNotMatch(html, /\buppercase tracking/);
  });

  test("can leave a code or a name exactly as written", () => {
    const html = render({ capitalize: false, className: "font-mono" }, "SPR");
    assert.doesNotMatch(html, /first-letter:uppercase/);
    assert.match(html, /font-mono/);
  });

  test("is 12px medium text, never the old 10px capitals", () => {
    const html = render({}, "Draft");
    assert.match(html, /text-xs/);
    assert.match(html, /font-medium/);
    assert.doesNotMatch(html, /text-\[10px\]|text-\[11px\]/);
  });

  test("gives every tone its own tint, text and ring in both themes", () => {
    const classes = TONES.map((tone) => badgeClassName({ tone }));
    for (const [index, cls] of classes.entries()) {
      assert.match(cls, /\bbg-\w+-(50|100)\b/, TONES[index]);
      assert.match(cls, /\btext-\w+-(700|800)\b/, TONES[index]);
      assert.match(cls, /\bring-1\b/, TONES[index]);
      assert.match(cls, /\bdark:bg-/, TONES[index]);
      assert.match(cls, /\bdark:text-\w+-(200|300)\b/, TONES[index]);
    }
    assert.equal(new Set(classes).size, TONES.length, "no two tones look the same");
  });

  test("defaults to the neutral tone at the small size", () => {
    assert.equal(badgeClassName(), badgeClassName({ tone: "neutral", size: "sm" }));
    assert.match(badgeClassName(), /\bh-5\b/);
    assert.match(badgeClassName({ size: "md" }), /\bh-6\b/);
  });

  test("hides its icon and dot from screen readers", () => {
    const withIcon = render(
      { icon: React.createElement("svg", { "data-icon": "check" }) },
      "Connected",
    );
    assert.match(withIcon, /<span aria-hidden="true"[^>]*><svg data-icon="check"/);
    const withDot = render({ dot: true, tone: "danger" }, "Overdue");
    assert.match(withDot, /<span aria-hidden="true" class="[^"]*rounded-full[^"]*bg-rose-500/);
  });

  test("passes a title and other attributes through", () => {
    const html = render({ title: "Waiting to start", "aria-label": "Queued" }, "pending");
    assert.match(html, /title="Waiting to start"/);
    assert.match(html, /aria-label="Queued"/);
  });

  test("appends a caller's classes", () => {
    assert.match(badgeClassName({ className: "tabular-nums" }), /tabular-nums$/);
  });
});

describe("CountBadge", () => {
  test("draws the number with tabular figures", () => {
    const html = renderToStaticMarkup(React.createElement(CountBadge, { count: 12 }));
    assert.match(html, />12</);
    assert.match(html, /tabular-nums/);
    assert.match(html, /text-xs/);
  });

  test("keeps an accessible label when given one", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountBadge, { count: 3, "aria-label": "3 waiting", tone: "accent" }),
    );
    assert.match(html, /aria-label="3 waiting"/);
    assert.match(html, /bg-indigo-100/);
  });
});
