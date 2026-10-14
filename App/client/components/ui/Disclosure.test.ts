import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure, type DisclosureProps } from "./Disclosure.js";

// `createElement` does not count children passed as arguments toward a required
// `children` prop, and lint forbids passing them as a prop, so type the
// component's props as optional here.
const Component = Disclosure as React.ComponentType<Partial<DisclosureProps>>;

const render = (props: Partial<Omit<DisclosureProps, "children">> = {}) =>
  renderToStaticMarkup(
    React.createElement(
      Component,
      { title: "Advanced", summary: "Approval required · 2 Checks", ...props },
      React.createElement("p", null, "The hidden options"),
    ),
  );

describe("Disclosure", () => {
  test("is closed by default, and still says what is set inside", () => {
    const html = render();
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, />Advanced</);
    assert.match(html, /Approval required · 2 Checks/);
    assert.doesNotMatch(html, /The hidden options/);
    // Nothing for the button to control while its content is not rendered.
    assert.doesNotMatch(html, /aria-controls/);
  });

  test("shows its content when it starts open", () => {
    const html = render({ defaultOpen: true });
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /The hidden options/);
    // (`aria-hidden` on the chevron is not the panel's `hidden`.)
    assert.doesNotMatch(html, / hidden=/);
  });

  test("can keep its content mounted, but hidden, while closed", () => {
    const html = render({ keepMounted: true });
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /The hidden options/);
    assert.match(html, / hidden=""/);
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    assert.ok(controls, "the button names the panel it controls");
    assert.ok(html.includes(`id="${controls}"`));
  });

  test("follows the open state it is given", () => {
    assert.match(render({ open: true }), /The hidden options/);
    assert.doesNotMatch(render({ open: false }), /The hidden options/);
  });

  test("can wrap its toggle in a heading", () => {
    assert.match(render({ heading: "h2" }), /<h2[^>]*><button/);
    assert.doesNotMatch(render(), /<h2/);
  });

  test("the card variant is one card, and the row variant is not", () => {
    assert.match(render({ variant: "card" }), /^<div class="[^"]*shadow-sm[^"]*">/);
    assert.doesNotMatch(render({ variant: "row" }), /^<div class="[^"]*shadow-sm/);
  });
});
