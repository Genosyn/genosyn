import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { Card, CardBody, CardDescription, CardHeader, CardTitle, cardClassName } from "./Card.js";
import { Checkbox } from "./Checkbox.js";
import { EmptyState } from "./EmptyState.js";
import { fieldClassName } from "./Input.js";
import { Skeleton, SkeletonList } from "./Skeleton.js";
import { TD, TH, THead, TR, Table, TableCard, theadClassName } from "./Table.js";

const h = React.createElement;
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("Card", () => {
  test("is a white card on light pages and a raised slate-900 card on dark ones", () => {
    assert.match(cardClassName, /rounded-xl/);
    assert.match(cardClassName, /border-slate-200/);
    assert.match(cardClassName, /shadow-sm/);
    assert.match(cardClassName, /dark:bg-slate-900/);
    assert.doesNotMatch(cardClassName, /dark:bg-slate-950/, "the dark page is slate-950");
  });

  test("composes a header, title, description and body", () => {
    const out = html(
      h(
        Card,
        { className: "mt-4" },
        h(CardHeader, null, h(CardTitle, null, "General"), h(CardDescription, null, "Name and slug.")),
        h(CardBody, null, "fields"),
      ),
    );
    assert.match(out, /^<div class="[^"]*rounded-xl[^"]*mt-4">/);
    assert.match(out, /<h2 class="text-sm font-semibold[^"]*">General<\/h2>/);
    assert.match(out, /<p class="mt-0\.5 text-sm text-slate-500[^"]*">Name and slug\.<\/p>/);
    assert.match(out, /p-4 sm:p-5[^>]*>fields</);
  });

  test("lets a card title be a level-three heading", () => {
    assert.match(html(h(CardTitle, { as: "h3" }, "Lines")), /^<h3/);
  });
});

describe("EmptyState", () => {
  test("says what would be here and offers the one action", () => {
    const out = html(
      h(EmptyState, {
        title: "No routines yet",
        description: "A routine is recurring work.",
        action: h("button", null, "New routine"),
        icon: h("svg", { "data-icon": "calendar" }),
      }),
    );
    assert.match(out, /<h3[^>]*>No routines yet<\/h3>/);
    assert.match(out, /A routine is recurring work\./);
    assert.match(out, /<button>New routine<\/button>/);
    // The icon is decoration in a soft tile.
    assert.match(out, /<div aria-hidden="true" class="[^"]*rounded-xl[^"]*"><svg data-icon="calendar"/);
  });

  test("draws no icon tile without an icon", () => {
    assert.doesNotMatch(html(h(EmptyState, { title: "Nothing" })), /aria-hidden/);
  });
});

describe("fieldClassName", () => {
  test("a field reads as a field at rest and turns indigo on focus", () => {
    const cls = fieldClassName();
    assert.match(cls, /\bborder-slate-300\b/);
    assert.match(cls, /\bfocus:border-indigo-500\b/);
    assert.match(cls, /\bfocus:outline-none\b/);
    assert.match(cls, /\bdark:focus:border-indigo-400\b/);
    assert.match(cls, /\bdisabled:cursor-not-allowed\b/);
  });

  test("a rejected field is red, at rest and on focus", () => {
    const cls = fieldClassName({ invalid: true });
    assert.match(cls, /\bborder-red-400\b/);
    assert.match(cls, /\bfocus:border-red-500\b/);
    assert.doesNotMatch(cls, /\bborder-slate-300\b/);
  });
});

describe("Table", () => {
  test("scrolls sideways inside its card instead of cutting columns off", () => {
    const out = html(h(TableCard, null, h(Table, null, h("tbody"))));
    assert.match(out, /^<div class="overflow-x-auto rounded-xl border/);
    assert.match(out, /<table class="w-full text-sm">/);
  });

  test("headers are sentence case, column headers scoped to their column", () => {
    assert.doesNotMatch(theadClassName, /uppercase|tracking/);
    const out = html(
      h(
        "table",
        null,
        h(THead, null, h("tr", null, h(TH, null, "Name"), h(TH, { align: "right" }, "Total"))),
      ),
    );
    assert.match(out, /<th scope="col" class="[^"]*text-left[^"]*">Name<\/th>/);
    assert.match(out, /<th scope="col" class="[^"]*text-right[^"]*">Total<\/th>/);
  });

  test("numeric cells line up and interactive rows look clickable", () => {
    const out = html(
      h(
        "table",
        null,
        h(
          "tbody",
          null,
          h(TR, { interactive: true }, h(TD, { numeric: true, align: "right" }, "$1,718.00")),
        ),
      ),
    );
    assert.match(out, /<tr class="[^"]*cursor-pointer[^"]*hover:bg-slate-50/);
    assert.match(out, /<td class="[^"]*text-right[^"]*tabular-nums[^"]*">\$1,718\.00<\/td>/);
  });
});

describe("Skeleton", () => {
  test("is hidden from screen readers and stops pulsing for reduced motion", () => {
    const out = html(h(Skeleton, { className: "h-4 w-40" }));
    assert.match(out, /aria-hidden="true"/);
    assert.match(out, /animate-pulse/);
    assert.match(out, /motion-reduce:animate-none/);
    assert.match(out, /h-4 w-40/);
  });

  test("a list placeholder draws the rows it stands in for", () => {
    const out = html(h(SkeletonList, { rows: 3 }));
    assert.equal(out.match(/px-4 py-3\.5/g)?.length, 3);
  });
});

describe("Breadcrumbs", () => {
  const render = (element: React.ReactElement) =>
    renderToStaticMarkup(h(StaticRouter, { location: "/" }, element));

  test("links every crumb but the page you are on", () => {
    const out = render(
      h(Breadcrumbs, {
        items: [{ label: "Finance", to: "/c/acme/finance" }, { label: "Invoices", to: "/x" }, { label: "New" }],
      }),
    );
    assert.match(out, /<nav aria-label="Breadcrumb"/);
    assert.match(out, /href="\/c\/acme\/finance"[^>]*>Finance<\/a>/);
    assert.match(out, /href="\/x"[^>]*>Invoices<\/a>/);
    assert.match(out, /aria-current="page"[^>]*>New<\/span>/);
    // The separators are decoration.
    assert.equal(out.match(/aria-hidden="true"/g)?.length, 2);
  });

  test("renders nothing for an empty trail", () => {
    assert.equal(render(h(Breadcrumbs, { items: [] })), "");
  });

  test("a crumb link is finger-sized on touch screens without growing", () => {
    const out = render(h(Breadcrumbs, { items: [{ label: "Finance", to: "/f" }, { label: "New" }] }));
    assert.match(out, /<a class="touch-target relative [^"]*py-0\.5/);
  });
});

describe("Checkbox", () => {
  const box = (props: Partial<React.ComponentProps<typeof Checkbox>> = {}) =>
    html(h(Checkbox, { checked: false, label: "Select invoice INV-1", onChange: () => undefined, ...props }));

  test("sits in a finger-sized target that takes no more room than the box", () => {
    const out = box();
    assert.match(out, /^<span class="touch-target relative inline-flex shrink-0"><input /);
    assert.match(out, /<\/span>$/);
    assert.match(out, /class="h-4 w-4 /, "the box itself stays 16px");
  });

  test("the box keeps its name and state; the target is not a label", () => {
    const out = box({ checked: true, className: "mt-0.5" });
    assert.match(out, /<input type="checkbox" aria-label="Select invoice INV-1"[^>]* checked=""/);
    assert.match(out, /mt-0\.5/, "callers still place the box");
    assert.doesNotMatch(out, /<label/, "a box often sits inside its caller's own label");
  });
});
