import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import { DialogProvider } from "../components/ui/Dialog.js";
import type { Company, Me } from "../lib/api.js";
import { canOpenSubpage, subpageAt } from "../lib/subpages.js";
import AuditLog from "./AuditLog.js";
import CustomersIndex from "./CustomersIndex.js";
import CustomersLayout from "./CustomersLayout.js";
import { SettingsEmail } from "./SettingsEmail.js";
import { SettingsEmailLogs } from "./SettingsEmailLogs.js";
import SettingsLayout from "./SettingsLayout.js";
import { SettingsSso } from "./SettingsSso.js";
import Usage from "./Usage.js";

/**
 * Pages a viewer can't open, reached anyway: a bookmark, a shared link, a
 * legacy redirect, or (for Customers) the section's own nav link. The rails
 * and the palette already leave these pages out; here each page answers for
 * itself, with a note in place of the page, from the same catalogue entry.
 *
 * Effects don't run in a server render, so a request can't be watched for
 * here. What can be checked is the thing that decides it: whether the part of
 * the page that loads data mounted at all. Every loading page draws a spinner
 * on its first render, which is the render this produces, so a closed page
 * must show none of the page's own controls and nothing loading.
 */

const h = React.createElement;

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

/** The Customers landing as `App.tsx` mounts it. */
function renderCustomers(company: Company): string {
  return render(
    "customers",
    h(
      Route,
      { path: "/c/:companySlug/customers", element: h(CustomersLayout, { company }) },
      h(Route, { index: true, element: h(CustomersIndex) }),
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
