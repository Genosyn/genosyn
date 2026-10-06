import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import type { Company, CustomerMailPage } from "../lib/api.js";
import { DialogProvider } from "../components/ui/Dialog.js";
import ContractsIndex from "./ContractsIndex.js";
import CustomerDetail from "./CustomerDetail.js";
import { CustomerMailList } from "./CustomerMailPanel.js";
import CustomerNew from "./CustomerNew.js";
import { CustomerPeoplePanel } from "./CustomerRelationshipPanels.js";
import CustomerStatement from "./CustomerStatement.js";
import CustomersIndex from "./CustomersIndex.js";
import CustomersLayout from "./CustomersLayout.js";

/**
 * The finance routes write customers, so a Member with read-only Finance
 * access can open the customer list and every customer's page but has each
 * create, edit, archive, and delete refused (`requireFinanceWrite`). These
 * render the real pages inside the real layout and check that a read-only
 * Member is not offered the controls that could only fail, while everyone who
 * can write gets the pages exactly as before.
 *
 * Server rendering draws a page as it stands before its data arrives, so this
 * covers the list's New customer and the create and edit routes themselves,
 * and renders the detail page's mail and people panels from data directly.
 * `server/client/financeReadOnly.test.ts` holds the Customers pages to the
 * same rule for the rest of what they draw once their data is in: the row
 * menu, the detail page's Edit, and its billing tab's New links.
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
const memberWithoutFinance = { ...fullMember, financeAccess: "none" } satisfies Company;

/**
 * Everyone who may change customers. Owners and admins are Full whatever their
 * membership row says, so a None row on one of them must change nothing.
 */
const WRITERS: [string, Company][] = [
  ["owner", owner],
  ["admin", admin],
  ["Member with Full access", fullMember],
  ["owner with a None row", { ...owner, financeAccess: "none" }],
  ["admin with a None row", { ...admin, financeAccess: "none" }],
];

/** The Customers routes besides the list, as `App.tsx` mounts them. */
const ROUTES: [string, React.ComponentType][] = [
  ["new", CustomerNew],
  ["contracts", ContractsIndex],
  [":customerSlug", CustomerDetail],
  [":customerSlug/statement", CustomerStatement],
  [":customerSlug/edit", CustomerNew],
];

/** Render Customers as `company` sees it at `/c/acme/customers/<at>`. */
function renderCustomers(at: string, company: Company): string {
  return renderToStaticMarkup(
    h(
      DialogProvider,
      null,
      h(
        StaticRouter,
        { location: `/c/acme/customers${at ? `/${at}` : ""}` },
        h(
          Routes,
          null,
          h(
            Route,
            { path: "/c/:companySlug/customers", element: h(CustomersLayout, { company }) },
            h(Route, { index: true, element: h(CustomersIndex) }),
            ...ROUTES.map(([path, page]) => h(Route, { key: path, path, element: h(page) })),
          ),
        ),
      ),
    ),
  );
}

/** Render a panel the detail page draws once its data is in. */
function renderPanel(panel: React.ReactElement): string {
  return renderToStaticMarkup(h(StaticRouter, { location: "/c/acme/customers/acme-corp" }, panel));
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
const EDIT_FORM = "/c/acme/customers/acme-corp/edit";

describe("Customers for a Member with read-only Finance access", () => {
  test("lists customers without New customer", () => {
    for (const [who, company] of WRITERS) {
      assert.ok(buttons(renderCustomers("", company)).includes("New customer"), who);
    }
    const html = renderCustomers("", readOnlyMember);
    assert.equal(heading(html), "Customers", "the list still renders for a read-only Member");
    assert.equal(buttons(html).includes("New customer"), false);
    assert.deepEqual(
      links(html).filter((l) => /\/(?:new|edit)$/.test(l.href)),
      [],
      "no way into a form",
    );
  });

  test("meets a read-only Member who follows a link to a form with a note and a way back", () => {
    const forms: [string, string, string][] = [
      ["new", "New customer", "/c/acme/customers"],
      ["acme-corp/edit", "Edit customer", "/c/acme/customers/acme-corp"],
    ];
    for (const [at, title, back] of forms) {
      const html = renderCustomers(at, readOnlyMember);
      assert.equal(heading(html), title, at);
      assert.ok(text(html).includes(READ_ONLY_NOTE), at);
      assert.ok(text(html).includes("You can view customers but not create or edit them"), at);
      assert.ok(text(html).includes("Settings → Members"), at);
      assert.ok(
        links(html).some((l) => l.href === back && l.text === "Back"),
        `${at} leads back to ${back}`,
      );
      // Nothing to fill in: the form, and the loads it starts, never mount.
      assert.equal(/<form\b/.test(html), false, at);

      for (const [who, company] of WRITERS) {
        assert.equal(text(renderCustomers(at, company)).includes(READ_ONLY_NOTE), false, who);
      }
    }
    for (const [who, company] of WRITERS) {
      const html = renderCustomers("new", company);
      assert.ok(/<form\b/.test(html), `${who} gets the New customer form`);
      assert.ok(buttons(html).includes("Create customer"), who);
    }
  });

  test("tells a Member without finance access who follows a link to a form that they have none", () => {
    // Contracts keep the Customers section open to them, so a saved link to a
    // form can still land here; they can't view customers, let alone edit one.
    for (const at of ["new", "acme-corp/edit"]) {
      const html = text(renderCustomers(at, memberWithoutFinance));
      assert.ok(html.includes("You don't have access to Finance"), at);
      assert.equal(html.includes(READ_ONLY_NOTE), false, at);
      assert.equal(html.includes("You can view customers"), false, at);
    }
  });

  test("leaves the mail panel without its way into the edit form", () => {
    const mail: CustomerMailPage = {
      threads: [],
      total: 0,
      limit: 25,
      offset: 0,
      addresses: [],
      domain: null,
      mailboxCount: 1,
      indexing: false,
    };
    const writer = renderPanel(
      h(CustomerMailList, { mail, companySlug: "acme", editTo: EDIT_FORM }),
    );
    assert.ok(links(writer).some((l) => l.href === EDIT_FORM && l.text === "Edit customer"));
    assert.ok(text(writer).includes("Add a billing email"));

    const reader = renderPanel(h(CustomerMailList, { mail, companySlug: "acme", editTo: null }));
    assert.ok(text(reader).includes("No email address to search"));
    assert.ok(text(reader).includes("billing email"), "still says what the search needs");
    assert.deepEqual(links(reader), []);
    assert.deepEqual(buttons(reader), []);
    assert.equal(text(reader).includes("Add a billing email"), false);
  });

  test("doesn't send a read-only Member to the edit page for billing contacts", () => {
    const people = (canEditBilling: boolean) =>
      text(
        renderPanel(
          h(CustomerPeoplePanel, {
            contacts: [],
            billingContacts: [],
            companySlug: "acme",
            members: [],
            employees: [],
            canEditBilling,
          }),
        ),
      );
    assert.ok(people(true).includes("on the customer's edit page"));
    assert.ok(people(false).includes("No billing contacts"));
    assert.equal(people(false).includes("edit page"), false);
  });

  test("leaves Contracts to every Member who can open them", () => {
    // `routes/contracts.ts` gates no contract on finance access, so neither
    // does the page: Read, and even None, still upload.
    const everyone: [string, Company][] = [
      ...WRITERS,
      ["read-only Member", readOnlyMember],
      ["Member without finance access", memberWithoutFinance],
    ];
    for (const [who, company] of everyone) {
      const html = renderCustomers("contracts", company);
      assert.equal(heading(html), "Contracts", who);
      assert.ok(buttons(html).includes("Upload contract"), who);
    }
  });

  test("draws every page the same for each viewer who can write", () => {
    for (const at of ["", ...ROUTES.map(([path]) => path.replace(/:[^/]+/g, "acme-corp"))]) {
      const [[, first], ...rest] = WRITERS;
      const expected = renderCustomers(at, first);
      for (const [who, company] of rest) {
        assert.equal(renderCustomers(at, company), expected, `${who} at /${at}`);
      }
    }
  });
});
