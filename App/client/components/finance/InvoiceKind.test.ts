import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";

import type { Company } from "../../lib/api.js";
import { InvoiceKindChoice, InvoiceKindSwitch } from "./InvoiceKind.js";

/**
 * The question New invoice asks and the switch both new-invoice forms keep,
 * as server rendering draws them: what each offers, where each link goes,
 * and what a screen reader is told.
 */

const h = React.createElement;

const company = {
  id: "company",
  slug: "acme",
  name: "Acme",
  mission: "",
  vision: "",
  role: "owner",
  financeAccess: "full",
  requireTwoFactor: false,
} satisfies Company;

function render(element: React.ReactElement, location = "/c/acme/finance/invoices/new"): string {
  return renderToStaticMarkup(h(StaticRouter, { location }, element));
}

/** The few entities React escapes in text. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

type Anchor = { attrs: string; href: string; text: string };

function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    attrs: m[1],
    href: decode(/href="([^"]*)"/.exec(m[1])?.[1] ?? ""),
    text: text(m[2]),
  }));
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match ? decode(match[1]) : null;
}

/** The text of the element with `id`. */
function textOfId(html: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<(\\w+)[^>]*\\bid="${escaped}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  assert.ok(match, `an element with id ${id}`);
  return text(match[2]);
}

describe("the one-time-or-recurring question", () => {
  test("asks it under New invoice, before any field", () => {
    const html = render(h(InvoiceKindChoice, { company, customerId: null }));
    assert.match(html, /<h1\b[^>]*>New invoice<\/h1>/);
    assert.match(
      html,
      /<h2\b[^>]*tabindex="-1"[^>]*>Is this a one-time invoice or a recurring invoice\?<\/h2>/,
    );
    assert.equal(/<(input|textarea|select|form)\b/.test(html), false, "nothing to fill in yet");
  });

  test("offers exactly two answers, each a link to its own form", () => {
    const html = render(h(InvoiceKindChoice, { company, customerId: null }));
    const answers = anchors(html).filter((a) => attr(a.attrs, "aria-labelledby"));
    assert.deepEqual(
      answers.map((a) => [textOfId(html, attr(a.attrs, "aria-labelledby")!), a.href]),
      [
        ["One-time invoice", "/c/acme/finance/invoices/new?kind=one-time"],
        ["Recurring invoice", "/c/acme/finance/recurring-invoices/new"],
      ],
    );
    for (const answer of answers) {
      const blurb = textOfId(html, attr(answer.attrs, "aria-describedby")!);
      assert.ok(blurb.length > 20, `${answer.href} says what it is for`);
    }
    assert.match(textOfId(html, attr(answers[0].attrs, "aria-describedby")!), /^Bill once/);
    assert.match(
      textOfId(html, attr(answers[1].attrs, "aria-describedby")!),
      /^Bill on a schedule/,
    );
  });

  test("keeps the customer the link asked for in both answers", () => {
    const html = render(h(InvoiceKindChoice, { company, customerId: "c-globex" }));
    const hrefs = anchors(html)
      .filter((a) => attr(a.attrs, "aria-labelledby"))
      .map((a) => a.href);
    assert.deepEqual(hrefs, [
      "/c/acme/finance/invoices/new?kind=one-time&customerId=c-globex",
      "/c/acme/finance/recurring-invoices/new?customerId=c-globex",
    ]);
  });

  test("holds a line open for the customer's name, and only when one was asked for", () => {
    const asked = render(h(InvoiceKindChoice, { company, customerId: "c-globex" }));
    assert.match(asked, /<p class="mt-1 min-h-5[^"]*"><\/p>/, "empty until the name loads");
    const none = render(h(InvoiceKindChoice, { company, customerId: null }));
    assert.equal(/min-h-5/.test(none), false);
  });

  test("says the answer can be changed later", () => {
    const html = render(h(InvoiceKindChoice, { company, customerId: null }));
    assert.match(text(html), /Picked the wrong one\? Both forms have a switch at the top/);
  });

  test("leads back to the invoice list, by name", () => {
    const html = render(h(InvoiceKindChoice, { company, customerId: null }));
    const back = anchors(html).find((a) => attr(a.attrs, "aria-label") === "Back to invoices");
    assert.equal(back?.href, "/c/acme/finance/invoices");
    const crumbs = anchors(html).map((a) => [a.text, a.href]);
    assert.deepEqual(crumbs.slice(0, 2), [
      ["Finance", "/c/acme/finance"],
      ["Invoices", "/c/acme/finance/invoices"],
    ]);
  });
});

describe("the One-time / Recurring switch", () => {
  const group = (html: string) => {
    const match = /<div role="group" aria-label="Invoice type"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    assert.ok(match, "a group labelled Invoice type");
    return match[1];
  };

  test("marks the form's own kind and links to the other", () => {
    const to = "/c/acme/finance/recurring-invoices/new?customerId=c-globex";
    const html = render(h(InvoiceKindSwitch, { current: "one-time", to, state: null }));
    const inside = group(html);
    assert.match(inside, /<span aria-current="page"[^>]*>.*One-time<\/span>/);
    const links = anchors(inside);
    assert.deepEqual(
      links.map((a) => [a.text, a.href]),
      [["Recurring", to]],
    );
    assert.match(text(html), /Billed once\. Switching keeps what you've entered\./);
  });

  test("on the recurring form, it is the other way round", () => {
    const to = "/c/acme/finance/invoices/new?kind=one-time";
    const html = render(h(InvoiceKindSwitch, { current: "recurring", to, state: null }));
    const inside = group(html);
    assert.match(inside, /<span aria-current="page"[^>]*>.*Recurring<\/span>/);
    assert.deepEqual(
      anchors(inside).map((a) => [a.text, a.href]),
      [["One-time", to]],
    );
    assert.match(text(html), /Billed on a schedule\. Switching keeps what you've entered\./);
  });

  test("offers no link while the form is saving", () => {
    const html = render(
      h(InvoiceKindSwitch, { current: "one-time", to: "/x", state: null, disabled: true }),
    );
    const inside = group(html);
    assert.deepEqual(anchors(inside), []);
    assert.match(inside, /<span aria-disabled="true"[^>]*>.*Recurring<\/span>/);
  });
});
