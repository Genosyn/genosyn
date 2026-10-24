import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SECTION_BY_KEY } from "../lib/sections.js";
import { sidebarLinkClassName } from "./AppShell.js";
import { RailIconButton, SectionRailHeader, railHeadingClassName } from "./SectionRail.js";

const h = React.createElement;

describe("SectionRailHeader", () => {
  test("draws the section's own icon tile and name, as the top nav's pill does", () => {
    const html = renderToStaticMarkup(h(SectionRailHeader, { section: "finance" }));
    assert.match(html, new RegExp(`>${SECTION_BY_KEY.finance.label}<`));
    for (const cls of SECTION_BY_KEY.finance.iconBg.split(" ")) {
      assert.ok(html.includes(cls), `the tile carries ${cls}`);
    }
    // A sentence-case title, not the tracked-out capitals rails used to draw.
    assert.match(html, /text-sm font-semibold/);
    assert.doesNotMatch(html, /uppercase|tracking-wider/);
  });

  test("keeps a label the layout passes, verbatim", () => {
    const html = renderToStaticMarkup(
      h(SectionRailHeader, { section: "tldrs", label: "What happened" }),
    );
    assert.match(html, />What happened</);
  });

  test("puts the rail's actions on the right", () => {
    const html = renderToStaticMarkup(
      h(SectionRailHeader, {
        section: "routines",
        actions: h(RailIconButton, { label: "New routine" }, "+"),
      }),
    );
    assert.ok(html.indexOf(SECTION_BY_KEY.routines.label) < html.indexOf("New routine"));
  });
});

describe("RailIconButton", () => {
  test("is named for screen readers and pointers alike, with a 32px target", () => {
    const html = renderToStaticMarkup(h(RailIconButton, { label: "New folder", disabled: true }, "+"));
    assert.match(html, /^<button type="button" aria-label="New folder" title="New folder" disabled=""/);
    assert.match(html, /\bh-8 w-8\b/);
  });
});

describe("rail styles", () => {
  test("group headings are 12px sentence case", () => {
    assert.equal(railHeadingClassName, "text-xs font-medium text-slate-500 dark:text-slate-400");
  });

  test("a rail link is a 32px row, tinted with the accent when it is the page you are on", () => {
    const active = sidebarLinkClassName(true);
    const idle = sidebarLinkClassName(false);
    for (const cls of [active, idle]) assert.match(cls, /min-h-\[2rem\]/);
    assert.match(active, /bg-indigo-50/);
    assert.match(active, /font-medium/);
    assert.match(active, /dark:bg-indigo-500\/15/);
    assert.doesNotMatch(idle, /bg-indigo-50/);
    assert.match(idle, /hover:bg-slate-100/);
  });
});
