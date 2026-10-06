import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import { DialogProvider } from "../components/ui/Dialog.js";
import type { Company, Me } from "../lib/api.js";
import { canOpenSubpage, effectiveFinanceAccess, subpageAt } from "../lib/subpages.js";
import AuditLog from "./AuditLog.js";
import ContractsIndex from "./ContractsIndex.js";
import CustomerDetail from "./CustomerDetail.js";
import CustomerNew from "./CustomerNew.js";
import CustomerStatement from "./CustomerStatement.js";
import CustomersIndex from "./CustomersIndex.js";
import CustomersLayout from "./CustomersLayout.js";
import { SettingsEmail } from "./SettingsEmail.js";
import { SettingsEmailLogs } from "./SettingsEmailLogs.js";
import SettingsLayout from "./SettingsLayout.js";
import { SettingsSso } from "./SettingsSso.js";
import Usage from "./Usage.js";

/**
 * Pages a viewer can't open, reached anyway: a bookmark, a shared link, a
 * legacy redirect, or (for Customers) the section's own nav link and a ⌘K
 * search result. The rails and the palette already leave these pages out;
 * here each page answers for itself, with a note in place of the page, by the
 * same rule.
 *
 * Effects don't run in a server render, so a request can't be watched for
 * here. What can be checked is the thing that decides it: whether the part of
 * the page that loads data mounted at all. Every loading page draws a spinner
 * on its first render, which is the render this produces, so a closed page
 * must show none of the page's own controls and nothing loading.
 */

const h = React.createElement;

// `Select` measures its menu in a layout effect, which React warns does
// nothing on the server. True, beside the point here, and repeated for every
// render of the New customer form, so it would bury any warning that matters.
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
const member = { ...owner, role: "member" } satisfies Company;
const memberReadOnly = { ...member, financeAccess: "read" } satisfies Company;
const memberNoFinance = { ...member, financeAccess: "none" } satisfies Company;
/**
 * Owners and admins whose membership row says None. The server resolves them
 * to Full before the client sees them; the client holds to that regardless.
 */
const ADMINS_WITH_A_NONE_ROW = [
  { ...owner, financeAccess: "none" },
  { ...admin, financeAccess: "none" },
] satisfies Company[];
const OWNERS_AND_ADMINS = [owner, admin, ...ADMINS_WITH_A_NONE_ROW];
const MEMBERS = [member, memberReadOnly, memberNoFinance];
const EVERYONE = [...OWNERS_AND_ADMINS, ...MEMBERS];

const me = {
  id: "me",
  email: "me@example.com",
  name: "Me",
  handle: null,
  avatarKey: null,
  isMasterAdmin: false,
  emailVerified: true,
  emailVerificationRequired: false,
} satisfies Me;

const who = (c: Company) => `${c.role}, finance ${c.financeAccess}`;

/** The few entities React escapes in text: "don&#x27;t" reads "don't". */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Anything spinning: a page's first render while its data is on the way. */
function loading(html: string): boolean {
  return /\banimate-spin\b/.test(html);
}

/** The page itself — `<main>` — without the rail beside it. */
function main(html: string): string {
  const match = /<main\b[\s\S]*<\/main>/.exec(html);
  assert.ok(match, "the layout must render a main pane");
  return match[0];
}

/** Render `routes` as if the browser were at `/c/acme/<at>`, decoded. */
function render(at: string, routes: React.ReactElement): string {
  return decode(
    renderToStaticMarkup(
      h(
        DialogProvider,
        null,
        h(StaticRouter, { location: `/c/acme/${at}` }, h(Routes, null, routes)),
      ),
    ),
  );
}

/** Settings as `App.tsx` mounts it, with the admin-only pages beneath. */
function renderSettings(at: string, company: Company): string {
  return render(
    at,
    h(
      Route,
      {
        path: "/c/:companySlug/settings",
        element: h(SettingsLayout, { company, me, onCompaniesChanged: () => {} }),
      },
      h(Route, { path: "usage", element: h(Usage) }),
      h(Route, { path: "sso", element: h(SettingsSso) }),
      h(Route, { path: "audit", element: h(AuditLog) }),
      h(
        Route,
        { path: "email", element: h(SettingsEmail) },
        h(Route, { path: "logs", element: h(SettingsEmailLogs) }),
      ),
    ),
  );
}

/** The Customers section as `App.tsx` mounts it, at its landing unless told. */
function renderCustomers(company: Company, at = "customers"): string {
  return render(
    at,
    h(
      Route,
      { path: "/c/:companySlug/customers", element: h(CustomersLayout, { company }) },
      h(Route, { index: true, element: h(CustomersIndex) }),
      h(Route, { path: "new", element: h(CustomerNew) }),
      h(Route, { path: "contracts", element: h(ContractsIndex) }),
      h(Route, { path: ":customerSlug", element: h(CustomerDetail) }),
      h(Route, { path: ":customerSlug/statement", element: h(CustomerStatement) }),
      h(Route, { path: ":customerSlug/edit", element: h(CustomerNew) }),
    ),
  );
}

type AdminOnlyPage = {
  /** Catalogue path, which is also where the page is mounted. */
  path: string;
  /** The heading above the page: its own, or Email's for the logs tab. */
  heading: string;
  /** The note a Member gets in place of the page. */
  note: string;
  /** Something only the page itself draws, once it has mounted. */
  own: string | null;
};

const ADMIN_ONLY_SETTINGS: AdminOnlyPage[] = [
  {
    path: "/settings/usage",
    heading: "Usage",
    note: "Only owners and admins see usage",
    own: "Last 30 days",
  },
  {
    path: "/settings/sso",
    heading: "Single sign-on",
    note: "Only owners and admins manage single sign-on",
    // Its first render is the loading card alone.
    own: null,
  },
  {
    path: "/settings/audit",
    heading: "Audit log",
    note: "Only owners and admins read the audit log",
    own: 'aria-label="Actor kind"',
  },
  {
    path: "/settings/email/logs",
    heading: "Email",
    note: "Only owners and admins read the email logs",
    own: "Recipient, subject, or error",
  },
];

const heading = (text: string) =>
  new RegExp(`<h1 class="[^"]*">${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`);

describe("admin-only Settings pages", () => {
  test("give a Member a note in place of the page, whatever their finance access", () => {
    for (const page of ADMIN_ONLY_SETTINGS) {
      for (const c of MEMBERS) {
        const html = renderSettings(page.path.slice(1), c);
        const at = `${page.path} for ${who(c)}`;
        assert.ok(html.includes(page.note), at);
        // Still headed by the page's name, so they know where they landed.
        assert.match(html, heading(page.heading), at);
        // The page never mounted: nothing it draws, and nothing loading.
        if (page.own) assert.equal(html.includes(page.own), false, at);
        assert.equal(loading(html), false, at);
      }
    }
  });

  test("open as before for owners and admins, whatever their finance row says", () => {
    for (const page of ADMIN_ONLY_SETTINGS) {
      for (const c of OWNERS_AND_ADMINS) {
        const html = renderSettings(page.path.slice(1), c);
        const at = `${page.path} for ${who(c)}`;
        assert.equal(html.includes("Only owners and admins"), false, at);
        assert.match(html, heading(page.heading), at);
        if (page.own) assert.ok(html.includes(page.own), at);
        assert.ok(loading(html), at);
      }
    }
  });

  test("close exactly when the catalogue says the viewer can't open the page", () => {
    for (const page of ADMIN_ONLY_SETTINGS) {
      assert.deepEqual(subpageAt(page.path).access, { admin: true }, page.path);
      for (const c of EVERYONE) {
        assert.equal(
          renderSettings(page.path.slice(1), c).includes(page.note),
          !canOpenSubpage(subpageAt(page.path), c),
          `${page.path} for ${who(c)}`,
        );
      }
    }
  });

  test("point a Member at what they can read instead", () => {
    const note = (path: string) => renderSettings(path, member);
    assert.ok(note("settings/usage").includes("A Run's own token count still shows in its Run log"));
    assert.ok(note("settings/sso").includes("ask an owner or admin for the login URL"));
    assert.ok(note("settings/audit").includes("choose it on Home for its work timeline"));
    assert.ok(note("settings/email/logs").includes("an owner or admin can check it here"));
  });
});

describe("the Customers landing", () => {
  const NOTE = "You don't have access to the customer list";

  test("gives a Member without finance access a note, and links to what stays open", () => {
    const html = renderCustomers(memberNoFinance);
    assert.ok(html.includes(NOTE));
    assert.ok(html.includes("Ask one of them to change yours under Settings → Members"));
    assert.match(html, heading("Customers"));
    // Revenue → Accounts lists the same rows, and Contracts never needed
    // finance access. Both links are in the page itself, not only the rail,
    // which a phone folds away.
    const page = main(html);
    assert.match(page, /<a [^>]*href="\/c\/acme\/revenue\/accounts"[^>]*>[\s\S]*?Revenue accounts<\/a>/);
    assert.match(page, /<a [^>]*href="\/c\/acme\/customers\/contracts"[^>]*>[\s\S]*?Contracts<\/a>/);
    // The list never mounted: no search, no create button, nothing loading.
    assert.equal(html.includes("Search customers"), false);
    assert.equal(html.includes("New customer"), false);
    assert.equal(loading(html), false);
  });

  test("lists customers for anyone with Read access or more, as before", () => {
    for (const c of [...OWNERS_AND_ADMINS, member, memberReadOnly]) {
      const html = renderCustomers(c);
      assert.equal(html.includes(NOTE), false, who(c));
      assert.ok(html.includes('aria-label="Search customers"'), who(c));
      assert.ok(html.includes("New customer"), who(c));
      assert.ok(html.includes('aria-label="Loading customers"'), who(c));
    }
  });

  test("closes exactly when the catalogue says the viewer can't open the list", () => {
    assert.deepEqual(subpageAt("/customers").access, { finance: "read" });
    for (const c of EVERYONE) {
      assert.equal(
        renderCustomers(c).includes(NOTE),
        !canOpenSubpage(subpageAt("/customers"), c),
        who(c),
      );
    }
  });
});

/**
 * An `<a>` to exactly `href` whose text ends in `text`, after any icon. It
 * never reaches past its own `</a>`, so a breadcrumb to the same place can't
 * stand in for the link under test.
 */
function linkTo(href: string, text: string): RegExp {
  return new RegExp(`<a [^>]*href="${href}"[^>]*>(?:(?!</a>)[\\s\\S])*${text}</a>`);
}

describe("a customer's overview and statement", () => {
  const NOTE = "You don't have access to this customer's page";
  /** Each page, and something only it draws once mounted. */
  const PAGES: { at: string; own: string | null }[] = [
    // The overview's first render is its spinner alone.
    { at: "customers/acme-corp", own: null },
    { at: "customers/acme-corp/statement", own: "Statement of account" },
  ];

  test("give a Member without finance access a note, and links to what stays open", () => {
    for (const { at, own } of PAGES) {
      const html = renderCustomers(memberNoFinance, at);
      assert.ok(html.includes(NOTE), at);
      assert.ok(html.includes("Ask one of them to change yours under Settings → Members"), at);
      assert.match(html, heading("Customers"), at);
      // Revenue → Accounts has the same account, and Contracts never needed
      // finance access; both are linked from the page, not only the rail.
      const page = main(html);
      assert.match(page, linkTo("/c/acme/revenue/accounts", "Revenue accounts"), at);
      assert.match(page, linkTo("/c/acme/customers/contracts", "Contracts"), at);
      // The page never mounted: nothing of its own, and nothing loading.
      if (own) assert.equal(html.includes(own), false, at);
      assert.equal(loading(html), false, at);
    }
  });

  test("open as before for anyone with Read access or more", () => {
    for (const { at, own } of PAGES) {
      for (const c of [...OWNERS_AND_ADMINS, member, memberReadOnly]) {
        const html = renderCustomers(c, at);
        assert.equal(html.includes(NOTE), false, `${at} for ${who(c)}`);
        if (own) assert.ok(html.includes(own), `${at} for ${who(c)}`);
        assert.ok(loading(html), `${at} for ${who(c)}`);
      }
    }
  });

  test("close exactly when the viewer's finance access is None", () => {
    // Neither page is catalogued, since each lives under one customer's slug.
    for (const { at } of PAGES) {
      for (const c of EVERYONE) {
        assert.equal(
          renderCustomers(c, at).includes(NOTE),
          effectiveFinanceAccess(c) === "none",
          `${at} for ${who(c)}`,
        );
      }
    }
  });
});

describe("the New customer and Edit customer forms", () => {
  const READ_ONLY = "Your finance access is read-only";
  const FORMS = [
    { at: "customers/new", title: "New customer", back: "/c/acme/customers" },
    { at: "customers/acme-corp/edit", title: "Edit customer", back: "/c/acme/customers/acme-corp" },
  ];

  test("give a Member without finance access the Customers note in place of either", () => {
    const notes: [string, string][] = [
      ["customers/new", "You don't have access to the customer list"],
      ["customers/acme-corp/edit", "You don't have access to this customer's page"],
    ];
    for (const [at, note] of notes) {
      const html = renderCustomers(memberNoFinance, at);
      assert.ok(html.includes(note), at);
      assert.equal(html.includes(READ_ONLY), false, at);
      assert.match(html, heading("Customers"), at);
      assert.match(main(html), linkTo("/c/acme/revenue/accounts", "Revenue accounts"), at);
      assert.match(main(html), linkTo("/c/acme/customers/contracts", "Contracts"), at);
      // No form, and no load of the customer an edit would start.
      assert.equal(/<form\b/.test(html), false, at);
      assert.equal(loading(html), false, at);
    }
  });

  test("meet a read-only Member with a note and a way back instead of a form", () => {
    for (const { at, title, back } of FORMS) {
      const html = renderCustomers(memberReadOnly, at);
      assert.ok(html.includes(READ_ONLY), at);
      assert.ok(html.includes("you can view customers but not add or edit them"), at);
      assert.ok(html.includes("Ask one of them to change yours under Settings → Members"), at);
      // Still headed by the form's name, so they know where they landed.
      assert.match(html, heading(title), at);
      assert.match(main(html), linkTo(back, "Back"), at);
      // Nothing to fill in only to be refused, and nothing loading.
      assert.equal(/<form\b/.test(html), false, at);
      assert.equal(loading(html), false, at);
    }
  });

  test("open as before for owners, admins, and Members with Full access", () => {
    for (const c of [...OWNERS_AND_ADMINS, member]) {
      const created = renderCustomers(c, "customers/new");
      assert.match(created, /<form\b/, who(c));
      assert.match(created, heading("New customer"), who(c));
      assert.ok(created.includes("Create customer"), who(c));
      // Editing loads the customer before it draws the form.
      const edited = renderCustomers(c, "customers/acme-corp/edit");
      assert.ok(loading(edited), who(c));
      for (const html of [created, edited]) {
        assert.equal(html.includes(READ_ONLY), false, who(c));
        assert.equal(html.includes("You don't have access"), false, who(c));
      }
    }
  });

  test("open exactly when the catalogue says the viewer can open New customer", () => {
    // Saving needs Full, which is what the catalogue asks of New customer;
    // an edit saves through the same routes.
    assert.deepEqual(subpageAt("/customers/new").access, { finance: "full" });
    for (const { at } of FORMS) {
      for (const c of EVERYONE) {
        const html = renderCustomers(c, at);
        assert.equal(
          /<form\b/.test(html) || loading(html),
          canOpenSubpage(subpageAt("/customers/new"), c),
          `${at} for ${who(c)}`,
        );
      }
    }
  });
});

describe("Contracts", () => {
  test("stays open to a Member without finance access, drawn as for everyone", () => {
    const [first, ...rest] = EVERYONE.map((c) => main(renderCustomers(c, "customers/contracts")));
    for (const [i, page] of rest.entries()) assert.equal(page, first, who(EVERYONE[i + 1]));
    assert.match(first, heading("Contracts"));
    assert.ok(first.includes("Upload contract"));
    assert.ok(loading(first));
    assert.equal(first.includes("You don't have access"), false);
  });
});
