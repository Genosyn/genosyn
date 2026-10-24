import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { Eyebrow, PageHeader, SectionHeader } from "./PageHeader.js";

const h = React.createElement;
const render = (element: React.ReactElement) =>
  renderToStaticMarkup(h(StaticRouter, { location: "/" }, element));

describe("PageHeader", () => {
  test("is one level-one heading with the shared title size", () => {
    const html = render(h(PageHeader, { title: "Contacts" }));
    assert.equal(html.match(/<h1/g)?.length, 1);
    const h1 = /<h1 class="([^"]*)">Contacts<\/h1>/.exec(html);
    assert.ok(h1, "the title is the h1's text");
    for (const name of ["text-xl", "sm:text-2xl", "font-semibold", "tracking-tight"]) {
      assert.ok(h1[1].split(" ").includes(name), `h1 has ${name}`);
    }
  });

  test("stacks its actions under the title on a phone, beside it from sm", () => {
    const html = render(
      h(PageHeader, { title: "Invoices", actions: h("button", null, "New invoice") }),
    );
    assert.match(html, /flex flex-col gap-3 sm:flex-row/);
    // Actions come after the title, so the primary button sits at the end.
    assert.ok(html.indexOf("Invoices") < html.indexOf("New invoice"));
  });

  test("draws breadcrumbs, a description and record facts when given", () => {
    const html = render(
      h(PageHeader, {
        title: "Morning triage",
        breadcrumbs: [{ label: "Routines", to: "/c/acme/routines" }, { label: "Morning triage" }],
        description: "Sort overnight email.",
        meta: h("span", null, "Every weekday at 8:00"),
        aside: h("span", { "data-badge": "" }, "Running"),
      }),
    );
    assert.match(html, /aria-label="Breadcrumb"/);
    assert.match(html, /href="\/c\/acme\/routines"/);
    assert.match(html, /aria-current="page"[^>]*>Morning triage</);
    assert.match(html, /<p class="[^"]*text-slate-500[^"]*">Sort overnight email\.<\/p>/);
    assert.match(html, /Every weekday at 8:00/);
    assert.match(html, /data-badge/);
  });

  test("leaves out what it was not given", () => {
    const html = render(h(PageHeader, { title: "Goals" }));
    assert.doesNotMatch(html, /Breadcrumb/);
    assert.doesNotMatch(html, /<p /);
  });

  test("keeps mb-6 below itself unless a caller says otherwise", () => {
    assert.match(render(h(PageHeader, { title: "A" })), /^<header class="mb-6">/);
    assert.match(render(h(PageHeader, { title: "A", className: "mb-4" })), /^<header class="mb-4">/);
  });
});

describe("SectionHeader", () => {
  test("is a sentence-case heading with an optional count", () => {
    const html = render(h(SectionHeader, { title: "Recent invoices", count: 3 }));
    assert.match(html, /<h2 class="[^"]*text-sm font-semibold/);
    assert.match(html, />Recent invoices</);
    assert.match(html, /tabular-nums[^>]*>3</);
    assert.doesNotMatch(html, /uppercase/);
  });

  test("can be a level-three heading", () => {
    assert.match(render(h(SectionHeader, { title: "Lines", as: "h3" })), /<h3/);
  });
});

describe("Eyebrow", () => {
  test("is a 12px medium label, not tracked capitals", () => {
    const html = render(h(Eyebrow, null, "Assigned to"));
    assert.match(html, /text-xs font-medium text-slate-500/);
    assert.doesNotMatch(html, /uppercase|tracking/);
  });
});
