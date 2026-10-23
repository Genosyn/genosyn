import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import type { Company } from "../lib/api.js";
import { DialogProvider } from "../components/ui/Dialog.js";
import FinanceIndex from "./FinanceIndex.js";
import FinanceInvoiceNew from "./FinanceInvoiceNew.js";
import FinanceInvoices from "./FinanceInvoices.js";
import FinanceLayout from "./FinanceLayout.js";
import FinanceRecurringInvoiceNew from "./FinanceRecurringInvoiceNew.js";
import FinanceRecurringInvoices from "./FinanceRecurringInvoices.js";

/**
 * The real Finance routes, server-rendered, for where starting an invoice
 * lands: `invoices/new` asks one-time or recurring before it draws a form,
 * `?kind=one-time` is the form itself, and nothing else changes — editing an
 * invoice never asks, and a read-only Member is still met with a note.
 */

const h = React.createElement;

// `Select` measures its menu in a layout effect, which React warns does
// nothing on the server; beside the point here.
const consoleError = console.error.bind(console);
mock.method(console, "error", (...args: unknown[]) => {
  if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
});

const owner = {
  id: "company",
  slug: "acme",
  name: "Acme",
  mission: "",
  vision: "",
  role: "owner",
  financeAccess: "full",
  requireTwoFactor: false,
} satisfies Company;
const readOnlyMember = { ...owner, role: "member", financeAccess: "read" } satisfies Company;

const QUESTION = "Is this a one-time invoice or a recurring invoice?";

function renderFinance(at: string, company: Company = owner): string {
  return renderToStaticMarkup(
    h(
      DialogProvider,
      null,
      h(
        StaticRouter,
        { location: `/c/acme/finance/${at}` },
        h(
          Routes,
          null,
          h(
            Route,
            { path: "/c/:companySlug/finance", element: h(FinanceLayout, { company }) },
            h(Route, { index: true, element: h(FinanceIndex) }),
            h(Route, { path: "invoices", element: h(FinanceInvoices) }),
            h(Route, { path: "invoices/new", element: h(FinanceInvoiceNew) }),
            h(Route, { path: "invoices/:invoiceSlug/edit", element: h(FinanceInvoiceNew) }),
            h(Route, { path: "recurring-invoices", element: h(FinanceRecurringInvoices) }),
            h(Route, { path: "recurring-invoices/new", element: h(FinanceRecurringInvoiceNew) }),
          ),
        ),
      ),
    ),
  );
}

function decode(value: string): string {
  return value
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

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => decode(m[1]));
}

describe("starting an invoice", () => {
  test("New invoice asks one-time or recurring before it draws a form", () => {
    const html = renderFinance("invoices/new");
    assert.ok(text(html).includes(QUESTION));
    assert.equal(/<form\b/.test(html), false, "no form until the question is answered");
    const links = hrefs(html);
    assert.ok(links.includes("/c/acme/finance/invoices/new?kind=one-time"));
    assert.ok(links.includes("/c/acme/finance/recurring-invoices/new"));
  });

  test("a customer's link keeps the customer in both answers", () => {
    const links = hrefs(renderFinance("invoices/new?customerId=c-globex"));
    assert.ok(links.includes("/c/acme/finance/invoices/new?kind=one-time&customerId=c-globex"));
    assert.ok(links.includes("/c/acme/finance/recurring-invoices/new?customerId=c-globex"));
  });

  test("only kind=one-time takes it past the question", () => {
    for (const at of [
      "invoices/new?kind=recurring",
      "invoices/new?kind=",
      "invoices/new?type=one-time",
    ]) {
      assert.ok(text(renderFinance(at)).includes(QUESTION), at);
    }
    const form = renderFinance("invoices/new?kind=one-time&customerId=c-globex");
    assert.equal(text(form).includes(QUESTION), false, "the one-time form, loading");
  });

  test("editing an invoice never asks", () => {
    assert.equal(text(renderFinance("invoices/inv-7/edit")).includes(QUESTION), false);
    assert.equal(
      text(renderFinance("invoices/inv-7/edit?kind=one-time")).includes(QUESTION),
      false,
    );
  });

  test("the recurring form opens directly, without the question", () => {
    assert.equal(text(renderFinance("recurring-invoices/new")).includes(QUESTION), false);
    assert.equal(
      text(renderFinance("recurring-invoices/new?customerId=c-globex")).includes(QUESTION),
      false,
    );
  });

  test("a read-only Member who follows the link gets the note, not the question", () => {
    const html = renderFinance("invoices/new", readOnlyMember);
    assert.equal(text(html).includes(QUESTION), false);
    assert.ok(text(html).includes("You have read-only access to Finance"));
  });

  test("New invoice on the list and the overview opens the question; New schedule opens the schedule", () => {
    assert.ok(hrefs(renderFinance("invoices")).includes("/c/acme/finance/invoices/new"));
    assert.ok(hrefs(renderFinance("")).includes("/c/acme/finance/invoices/new"));
    const recurring = hrefs(renderFinance("recurring-invoices"));
    assert.ok(recurring.includes("/c/acme/finance/recurring-invoices/new"));
    assert.equal(
      recurring.some((href) => href.includes("/invoices/new?kind")),
      false,
    );
  });
});
