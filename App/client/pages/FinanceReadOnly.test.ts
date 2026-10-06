import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import type { Company } from "../lib/api.js";
import { DialogProvider } from "../components/ui/Dialog.js";
import FinanceAccounts from "./FinanceAccounts.js";
import FinanceAiAccess from "./FinanceAiAccess.js";
import FinanceBillNew from "./FinanceBillNew.js";
import FinanceBills from "./FinanceBills.js";
import FinanceCardExpenses from "./FinanceCardExpenses.js";
import FinanceEstimateNew from "./FinanceEstimateNew.js";
import FinanceEstimates from "./FinanceEstimates.js";
import FinanceIndex from "./FinanceIndex.js";
import FinanceInvoiceNew from "./FinanceInvoiceNew.js";
import FinanceInvoices from "./FinanceInvoices.js";
import FinanceJournal from "./FinanceJournal.js";
import FinanceLayout from "./FinanceLayout.js";
import FinancePeriods from "./FinancePeriods.js";
import FinanceProducts from "./FinanceProducts.js";
import FinanceReconcile from "./FinanceReconcile.js";
import FinanceRecurringInvoiceNew from "./FinanceRecurringInvoiceNew.js";
import FinanceRecurringInvoices from "./FinanceRecurringInvoices.js";
import FinanceTaxRates from "./FinanceTaxRates.js";
import FinanceVendors from "./FinanceVendors.js";

/**
 * A Member with read-only Finance access can open every Finance page, but the
 * server refuses each change they try (`requireFinanceWrite`). These render
 * the real pages inside the real layout and check that a read-only Member is
 * not offered the controls that could only fail, while everyone who can write
 * gets the page exactly as before. AI access asks more than Full access: only
 * owners and admins may change an AI Employee's finance access, so every other
 * Member reads that page the way a read-only Member does.
 *
 * Server rendering draws a page as it stands before its data arrives, so this
 * covers what a page shows up front — its create buttons, and the create and
 * edit routes themselves. `server/client/financeReadOnly.test.ts` holds every
 * Finance page that writes to the same rule for what it draws afterwards.
 */

const h = React.createElement;

// `Select` measures its menu in a layout effect, which React warns does
// nothing on the server. True, beside the point here, and repeated for every
// render that draws one, so it would bury any warning that matters.
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
const admin = { ...owner, role: "admin" } satisfies Company;
const fullMember = { ...owner, role: "member" } satisfies Company;
const readOnlyMember = { ...fullMember, financeAccess: "read" } satisfies Company;

/**
 * Everyone who may change finances. Owners and admins are Full whatever their
 * membership row says, so a None row on one of them must change nothing.
 */
const WRITERS: [string, Company][] = [
  ["owner", owner],
  ["admin", admin],
  ["Member with Full access", fullMember],
  ["owner with a None row", { ...owner, financeAccess: "none" }],
  ["admin with a None row", { ...admin, financeAccess: "none" }],
];

/**
 * The writers who may also change an AI Employee's finance access, which the
 * server keeps to owners and admins whatever a Member's Finance access is.
 */
const ADMINS = WRITERS.filter(
  ([, company]) => company.role === "owner" || company.role === "admin",
);

/** Members who can open Finance, at either level, but not change AI access. */
const MEMBERS: [string, Company][] = [
  ["Member with Full access", fullMember],
  ["Member with read-only access", readOnlyMember],
];

/** The Finance routes under test, as `App.tsx` mounts them. */
const ROUTES: [string, React.ComponentType][] = [
  ["invoices", FinanceInvoices],
  ["invoices/new", FinanceInvoiceNew],
  ["invoices/:invoiceSlug/edit", FinanceInvoiceNew],
  ["estimates", FinanceEstimates],
  ["estimates/new", FinanceEstimateNew],
  ["estimates/:estimateSlug/edit", FinanceEstimateNew],
  ["recurring-invoices", FinanceRecurringInvoices],
  ["recurring-invoices/new", FinanceRecurringInvoiceNew],
  ["recurring-invoices/:recurringSlug/edit", FinanceRecurringInvoiceNew],
  ["bills", FinanceBills],
  ["bills/new", FinanceBillNew],
  ["vendors", FinanceVendors],
  ["products", FinanceProducts],
  ["tax-rates", FinanceTaxRates],
  ["accounts", FinanceAccounts],
  ["journal", FinanceJournal],
  ["periods", FinancePeriods],
  ["reconcile", FinanceReconcile],
  ["card-expenses", FinanceCardExpenses],
  ["ai-access", FinanceAiAccess],
];

/** Render Finance as `company` sees it at `/c/acme/finance/<at>`. */
function renderFinance(at: string, company: Company): string {
  return renderToStaticMarkup(
    h(
      DialogProvider,
      null,
      h(
        StaticRouter,
        { location: `/c/acme/finance${at ? `/${at}` : ""}` },
        h(
          Routes,
          null,
          h(
            Route,
            { path: "/c/:companySlug/finance", element: h(FinanceLayout, { company }) },
            h(Route, { index: true, element: h(FinanceIndex) }),
            ...ROUTES.map(([path, page]) => h(Route, { key: path, path, element: h(page) })),
          ),
        ),
      ),
    ),
  );
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

/** An element's text, tags dropped and whitespace collapsed. */
function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function links(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(/href="([^"]*)"/.exec(m[1])?.[1] ?? ""),
    text: text(m[2]),
  }));
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));
}

function heading(html: string): string {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  assert.ok(match, "the page must render a heading");
  return text(match[1]);
}

const READ_ONLY_NOTE = "You have read-only access to Finance";

describe("Finance for a Member with read-only access", () => {
  test("lists invoices, estimates, bills, and schedules without a way into the create forms", () => {
    const pages: [string, string, string][] = [
      ["", "Finance", "/c/acme/finance/invoices/new"],
      ["invoices", "Invoices", "/c/acme/finance/invoices/new"],
      ["estimates", "Estimates", "/c/acme/finance/estimates/new"],
      ["bills", "Bills", "/c/acme/finance/bills/new"],
      ["recurring-invoices", "Recurring invoices", "/c/acme/finance/recurring-invoices/new"],
    ];
    for (const [at, title, form] of pages) {
      for (const [who, company] of WRITERS) {
        const html = renderFinance(at, company);
        assert.ok(
          links(html).some((l) => l.href === form),
          `${who} at /${at} is offered ${form}`,
        );
      }
      const html = renderFinance(at, readOnlyMember);
      assert.equal(heading(html), title, `/${at} still renders for a read-only Member`);
      assert.deepEqual(
        links(html).filter((l) => l.href.endsWith("/new")),
        [],
        `/${at} offers a read-only Member no create form`,
      );
    }
  });

  test("leaves out every other control a page draws to add something", () => {
    const pages: [string, string, string][] = [
      ["vendors", "Vendors", "New vendor"],
      ["products", "Products & services", "New product"],
      ["tax-rates", "Tax rates", "New rate"],
      ["accounts", "Chart of accounts", "New account"],
      ["journal", "Journal", "Manual entry"],
      ["periods", "Periods & exports", "New period"],
      ["reconcile", "Reconciliation", "New feed"],
      ["card-expenses", "Card expenses", "Connect card feed"],
    ];
    for (const [at, title, label] of pages) {
      for (const [who, company] of WRITERS) {
        assert.ok(buttons(renderFinance(at, company)).includes(label), `${who}: "${label}"`);
      }
      const html = renderFinance(at, readOnlyMember);
      assert.equal(heading(html), title, `/${at} still renders for a read-only Member`);
      assert.equal(buttons(html).includes(label), false, `/${at} offers no "${label}"`);
    }
  });

  test("meets a read-only Member who follows a link to a form with a note and a way back", () => {
    const forms: [string, string, string][] = [
      ["invoices/new", "New invoice", "/c/acme/finance/invoices"],
      ["invoices/inv-7/edit", "Edit invoice", "/c/acme/finance/invoices/inv-7"],
      ["estimates/new", "New estimate", "/c/acme/finance/estimates"],
      ["estimates/est-3/edit", "Edit estimate", "/c/acme/finance/estimates/est-3"],
      ["recurring-invoices/new", "New recurring invoice", "/c/acme/finance/recurring-invoices"],
      [
        "recurring-invoices/retainer/edit",
        "Edit schedule",
        "/c/acme/finance/recurring-invoices/retainer",
      ],
      ["bills/new", "New bill", "/c/acme/finance/bills"],
    ];
    for (const [at, title, back] of forms) {
      const html = renderFinance(at, readOnlyMember);
      assert.equal(heading(html), title, at);
      assert.ok(text(html).includes(READ_ONLY_NOTE), at);
      assert.ok(text(html).includes("Settings → Members"), at);
      assert.ok(
        links(html).some((l) => l.href === back && l.text === "Back"),
        `${at} leads back to ${back}`,
      );
      // Nothing to fill in: the form, and the loads it starts, never mount.
      assert.equal(/<form\b/.test(html), false, at);

      for (const [who, company] of WRITERS) {
        assert.equal(text(renderFinance(at, company)).includes(READ_ONLY_NOTE), false, who);
      }
    }
  });

  test("draws every page the same for each viewer who can write", () => {
    for (const at of ["", ...ROUTES.map(([path]) => path.replace(/:[^/]+/g, "x"))]) {
      // Only owners and admins can write AI access; a Full Member reads it.
      const [[, first], ...rest] = at === "ai-access" ? ADMINS : WRITERS;
      const expected = renderFinance(at, first);
      for (const [who, company] of rest) {
        assert.equal(renderFinance(at, company), expected, `${who} at /${at}`);
      }
    }
  });
});

const ADMIN_ONLY_NOTE = "Only owners and admins can change AI employees' finance access";

describe("Finance AI access for a Member who is not an owner or admin", () => {
  test("shows the grants with a note in place of the way to add one", () => {
    for (const [who, company] of ADMINS) {
      const html = renderFinance("ai-access", company);
      assert.ok(buttons(html).includes("Add"), who);
      assert.ok(text(html).includes("Grant access to"), who);
      assert.equal(text(html).includes(ADMIN_ONLY_NOTE), false, who);
    }
    for (const [who, company] of MEMBERS) {
      const html = renderFinance("ai-access", company);
      assert.equal(heading(html), "AI access", `${who} can still open AI access`);
      assert.equal(buttons(html).includes("Add"), false, who);
      assert.equal(text(html).includes("Grant access to"), false, who);
      assert.ok(text(html).includes(ADMIN_ONLY_NOTE), who);
      // More Finance access would not let them change it, so the read-only
      // note's pointer to Settings → Members would send them the wrong way.
      assert.equal(text(html).includes(READ_ONLY_NOTE), false, who);
    }
  });

  test("draws it the same whatever their Finance access", () => {
    const [[, first], ...rest] = MEMBERS;
    const expected = renderFinance("ai-access", first);
    for (const [who, company] of rest) {
      assert.equal(renderFinance("ai-access", company), expected, who);
    }
  });
});
