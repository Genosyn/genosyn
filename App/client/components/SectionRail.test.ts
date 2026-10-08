import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import type { Company, Me } from "../lib/api.js";
import { productIntegrationScope } from "../lib/productIntegrations.js";
import { SECTION_BY_KEY, type SectionKey } from "../lib/sections.js";
import { SECTION_SUBPAGES, type SubpageViewer, railSubpages } from "../lib/subpages.js";
import AccountLayout from "../pages/AccountLayout.js";
import CustomersLayout from "../pages/CustomersLayout.js";
import DecisionsLayout from "../pages/DecisionsLayout.js";
import FinanceLayout from "../pages/FinanceLayout.js";
import MarketingLayout from "../pages/MarketingLayout.js";
import MeetingsLayout from "../pages/MeetingsLayout.js";
import ResourcesLayout from "../pages/ResourcesLayout.js";
import RevenueLayout from "../pages/RevenueLayout.js";
import SettingsLayout from "../pages/SettingsLayout.js";
import SignatureLayout from "../pages/SignatureLayout.js";
import TldrsLayout from "../pages/TldrsLayout.js";
import VaultLayout from "../pages/VaultLayout.js";
import { SectionRailLinks } from "./SectionRail.js";

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
const admin = { ...company, role: "admin" } satisfies Company;
const member = { ...company, role: "member" } satisfies Company;
const memberReadOnly = { ...member, financeAccess: "read" } satisfies Company;
const memberNoFinance = { ...member, financeAccess: "none" } satisfies Company;
/**
 * Owners and admins whose membership row says None. The server resolves them
 * to Full before the client sees them; the client holds to that regardless.
 */
const ADMINS_WITH_A_NONE_ROW = [
  { ...company, financeAccess: "none" },
  { ...admin, financeAccess: "none" },
] satisfies Company[];

/** The Settings rail's admin-only pages: each one's read answers a Member 403. */
const ADMIN_ONLY_SETTINGS = ["Usage", "Single sign-on", "Audit log"];

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

/** Render `element` as if the browser were at `/c/acme/<at>`. */
function renderAt(at: string, routePath: string, element: React.ReactElement): string {
  return renderToStaticMarkup(
    h(
      StaticRouter,
      { location: `/c/acme/${at}` },
      h(Routes, null, h(Route, { path: `/c/:companySlug/${routePath}`, element })),
    ),
  );
}

/** What a page mounted beneath a layout renders — its `<Outlet>` content. */
const PAGE_TEXT = "The page behind the rail";

/** `renderAt`, with a page mounted under `layout` at every path in `section`. */
function renderPageAt(at: string, section: string, layout: React.ReactElement): string {
  const page = h("p", null, PAGE_TEXT);
  return renderToStaticMarkup(
    h(
      StaticRouter,
      { location: `/c/acme/${at}` },
      h(
        Routes,
        null,
        h(
          Route,
          { path: `/c/:companySlug/${section}`, element: layout },
          h(Route, { index: true, element: page }),
          h(Route, { path: "*", element: page }),
        ),
      ),
    ),
  );
}

type Link = { href: string; text: string; current: boolean };

/** The few entities React escapes in text: "Periods &amp; exports" reads "Periods & exports". */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function links(html: string): Link[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(/href="([^"]*)"/.exec(m[1])?.[1] ?? ""),
    text: decode(m[2].replace(/<[^>]+>/g, "").trim()),
    current: /aria-current="page"/.test(m[1]),
  }));
}

/** Group headings, with whether each opened the rail (`pt-2`) or followed links (`pt-3`). */
function headings(html: string): { text: string; spacing: string }[] {
  return [...html.matchAll(/<div class="px-2 pb-1 (pt-[23]) [^"]*">([^<]+)<\/div>/g)].map((m) => ({
    text: m[2],
    spacing: m[1],
  }));
}

/** The desktop rail — `<aside>` — as `ContextualLayout` renders it. */
function aside(html: string): string {
  const match = /<aside\b[\s\S]*?<\/aside>/.exec(html);
  assert.ok(match, "the layout must render a rail");
  return match[0];
}

function expectedLinks(section: SectionKey) {
  return railSubpages(section).map((page) => ({
    href: `/c/acme${page.path}`,
    text: page.navLabel ?? page.label,
  }));
}

describe("SectionRailLinks", () => {
  const sections = (Object.keys(SECTION_SUBPAGES) as SectionKey[]).filter(
    (section) => railSubpages(section).length > 0,
  );

  test("draws every rail page of every section, in order, with the rail's wording", () => {
    assert.ok(sections.length >= 10);
    for (const section of sections) {
      const html = renderAt(
        section,
        `${section}/*`,
        h(SectionRailLinks, { section, companySlug: "acme" }),
      );
      assert.deepEqual(
        links(html).map(({ href, text }) => ({ href, text })),
        expectedLinks(section),
        section,
      );
      // One icon per link.
      assert.equal((html.match(/<svg\b/g) ?? []).length, railSubpages(section).length, section);
    }
  });

  test("draws each group heading once, opening the rail tighter than later ones", () => {
    const finance = renderAt(
      "finance",
      "finance/*",
      h(SectionRailLinks, { section: "finance", companySlug: "acme" }),
    );
    assert.deepEqual(headings(finance), [
      { text: "Ledger", spacing: "pt-3" },
      { text: "Catalog", spacing: "pt-3" },
    ]);
    const ledger = finance.indexOf(">Ledger<");
    assert.ok(ledger > finance.indexOf("Vendor credits"));
    assert.ok(ledger < finance.indexOf("Transactions"));

    const settings = renderAt(
      "settings/company",
      "settings/*",
      h(SectionRailLinks, { section: "settings", companySlug: "acme" }),
    );
    assert.deepEqual(headings(settings), [{ text: "Company", spacing: "pt-2" }]);
  });

  test("spaces the first heading like a later one when the rail continues another list", () => {
    const mail = renderAt(
      "mail",
      "mail/*",
      h(SectionRailLinks, { section: "mail", companySlug: "acme", continued: true }),
    );
    assert.deepEqual(headings(mail), [{ text: "Automation", spacing: "pt-3" }]);
    assert.deepEqual(
      links(mail).map((l) => l.text),
      ["Rules", "AI handovers", "Settings"],
    );
    const standalone = renderAt(
      "mail",
      "mail/*",
      h(SectionRailLinks, { section: "mail", companySlug: "acme" }),
    );
    assert.deepEqual(headings(standalone), [{ text: "Automation", spacing: "pt-2" }]);
  });

  test("highlights only the page you are on, never the section's landing page too", () => {
    const html = renderAt(
      "finance/recurring-invoices",
      "finance/*",
      h(SectionRailLinks, { section: "finance", companySlug: "acme" }),
    );
    assert.deepEqual(
      links(html).filter((l) => l.current).map((l) => l.text),
      ["Recurring"],
    );
    const landing = renderAt(
      "finance",
      "finance/*",
      h(SectionRailLinks, { section: "finance", companySlug: "acme" }),
    );
    assert.deepEqual(
      links(landing).filter((l) => l.current).map((l) => l.text),
      ["Overview"],
    );
    // A nested page keeps its own rail entry lit (no `end` below the landing page).
    const nested = renderAt(
      "finance/invoices/inv-7",
      "finance/*",
      h(SectionRailLinks, { section: "finance", companySlug: "acme" }),
    );
    assert.deepEqual(
      links(nested).filter((l) => l.current).map((l) => l.text),
      ["Invoices"],
    );
  });

  test("keeps the Decision stack's Active and History apart", () => {
    const at = (path: string) =>
      links(
        renderAt(
          path,
          "decisions/*",
          h(SectionRailLinks, { section: "decisions", companySlug: "acme" }),
        ),
      );
    assert.deepEqual(
      at("decisions").map(({ href, text, current }) => ({ href, text, current })),
      [
        { href: "/c/acme/decisions", text: "Active", current: true },
        { href: "/c/acme/decisions/history", text: "History", current: false },
      ],
    );
    assert.deepEqual(
      at("decisions/history").filter((l) => l.current).map((l) => l.text),
      ["History"],
    );
  });

  test("draws nothing for a section without catalogued rail pages", () => {
    const html = renderAt(
      "workspace",
      "workspace/*",
      h(SectionRailLinks, { section: "workspace", companySlug: "acme" }),
    );
    assert.equal(html, "");
  });

  test("draws owners' and admins' rails exactly as it does without a viewer", () => {
    for (const section of sections) {
      const render = (viewer?: SubpageViewer) =>
        renderAt(
          section,
          `${section}/*`,
          h(SectionRailLinks, { section, companySlug: "acme", viewer }),
        );
      const everything = render();
      for (const viewer of [company, admin, ...ADMINS_WITH_A_NONE_ROW]) {
        assert.equal(
          render(viewer),
          everything,
          `${section}: ${viewer.role}, ${viewer.financeAccess}`,
        );
      }
    }
  });

  test("leaves the admin-only Settings pages out for a Member, keeping the rest in order", () => {
    const everything = expectedLinks("settings");
    for (const text of ADMIN_ONLY_SETTINGS) {
      assert.ok(
        everything.some((l) => l.text === text),
        `the Settings rail lists ${text}`,
      );
    }
    for (const viewer of [member, memberReadOnly, memberNoFinance]) {
      const html = renderAt(
        "settings/members",
        "settings/*",
        h(SectionRailLinks, { section: "settings", companySlug: "acme", viewer }),
      );
      assert.deepEqual(
        links(html).map(({ href, text }) => ({ href, text })),
        everything.filter((l) => !ADMIN_ONLY_SETTINGS.includes(l.text)),
        viewer.financeAccess,
      );
      // The group keeps its heading, and the opening spacing, while a link remains.
      assert.deepEqual(headings(html), [{ text: "Company", spacing: "pt-2" }]);
      assert.deepEqual(
        links(html).filter((l) => l.current).map((l) => l.text),
        ["Members"],
      );
    }
  });

  test("follows Finance access, dropping each heading with the last of its links", () => {
    const finance = (viewer?: SubpageViewer) =>
      renderAt(
        "finance",
        "finance/*",
        h(SectionRailLinks, { section: "finance", companySlug: "acme", viewer }),
      );
    // Every Finance page needs at least Read, so None leaves no links, and no
    // "Ledger" or "Catalog" heading standing over an empty group.
    assert.equal(finance(memberNoFinance), "");
    // Read opens every rail page: the create forms that need Full aren't on it.
    assert.equal(finance(memberReadOnly), finance());
    assert.equal(finance(member), finance());

    // The customer list is served by the finance routes; Contracts is not.
    const customers = renderAt(
      "customers/contracts",
      "customers/*",
      h(SectionRailLinks, { section: "customers", companySlug: "acme", viewer: memberNoFinance }),
    );
    assert.deepEqual(
      links(customers).map((l) => l.text),
      ["Contracts"],
    );
  });
});

describe("section layouts draw their rails from the catalogue", () => {
  type Layout = [SectionKey, string, (company: Company) => React.ReactElement];
  const LAYOUTS: Layout[] = [
    ["finance", "finance", (c) => h(FinanceLayout, { company: c })],
    ["revenue", "revenue", (c) => h(RevenueLayout, { company: c })],
    ["marketing", "marketing", (c) => h(MarketingLayout, { company: c })],
    ["meetings", "meetings", (c) => h(MeetingsLayout, { company: c })],
    ["customers", "customers", (c) => h(CustomersLayout, { company: c })],
    ["resources", "resources", (c) => h(ResourcesLayout, { company: c })],
    ["signatures", "signatures", (c) => h(SignatureLayout, { company: c })],
    ["tldrs", "tldrs", (c) => h(TldrsLayout, { company: c })],
    ["decisions", "decisions/history", (c) => h(DecisionsLayout, { company: c })],
    ["vault", "vault", (c) => h(VaultLayout, { company: c })],
  ];
  const SETTINGS_AND_ACCOUNT: Layout[] = [
    [
      "settings",
      "settings/members",
      (c) => h(SettingsLayout, { company: c, me, onCompaniesChanged: () => {} }),
    ],
    [
      "account",
      "account/security",
      (c) => h(AccountLayout, { company: c, me, onCompaniesChanged: () => {} }),
    ],
  ];
  const routeFor = (section: SectionKey) => `${SECTION_BY_KEY[section].path.slice(1)}/*`;
  const hrefsAndText = (html: string) => links(html).map(({ href, text }) => ({ href, text }));

  test("renders exactly the catalogue's rail, plus the product Integrations link", () => {
    for (const [section, at, layout] of LAYOUTS) {
      const rail = links(aside(renderAt(at, routeFor(section), layout(company))));
      const expected = expectedLinks(section);
      if (productIntegrationScope(section)) {
        expected.push({ href: `/c/acme/${section}/integrations`, text: "Integrations" });
      }
      assert.deepEqual(
        rail.map(({ href, text }) => ({ href, text })),
        expected,
        section,
      );
    }
  });

  test("keeps the Settings and Account rails, with their breadcrumbs", () => {
    const settings = renderAt(
      "settings/members",
      "settings/*",
      h(SettingsLayout, { company, me, onCompaniesChanged: () => {} }),
    );
    assert.deepEqual(
      links(aside(settings)).map(({ href, text }) => ({ href, text })),
      expectedLinks("settings"),
    );
    assert.equal(links(aside(settings)).filter((l) => l.current).length, 1);
    assert.match(settings, /aria-label="Breadcrumb"[\s\S]*Settings[\s\S]*Members/);

    const account = renderAt(
      "account/security",
      "account/*",
      h(AccountLayout, { company, me, onCompaniesChanged: () => {} }),
    );
    assert.deepEqual(
      links(aside(account)).map(({ href, text }) => ({ href, text })),
      expectedLinks("account"),
    );
    assert.match(account, /aria-label="Breadcrumb"[\s\S]*Account[\s\S]*Security/);
  });

  test("still gives a Member no Vault rail at all", () => {
    const html = renderAt(
      "vault",
      "vault/*",
      h(VaultLayout, { company: { ...company, role: "member" } }),
    );
    assert.equal(/<aside\b/.test(html), false);
    assert.equal(html.includes("/vault/integrations"), false);
  });

  test("draws the same layout for every owner and admin, whatever their finance row says", () => {
    for (const [section, at, layout] of [...LAYOUTS, ...SETTINGS_AND_ACCOUNT]) {
      const owners = renderAt(at, routeFor(section), layout(company));
      for (const c of [admin, ...ADMINS_WITH_A_NONE_ROW]) {
        assert.equal(
          renderAt(at, routeFor(section), layout(c)),
          owners,
          `${section}: ${c.role}, ${c.financeAccess}`,
        );
      }
    }
  });

  test("gives a Member a Settings rail without the admin-only pages", () => {
    const rail = (c: Company) =>
      hrefsAndText(
        aside(
          renderAt(
            "settings/members",
            "settings/*",
            h(SettingsLayout, { company: c, me, onCompaniesChanged: () => {} }),
          ),
        ),
      );
    assert.deepEqual(
      rail(member),
      expectedLinks("settings").filter((l) => !ADMIN_ONLY_SETTINGS.includes(l.text)),
    );
    assert.deepEqual(rail(admin), expectedLinks("settings"));
  });

  test("closes Finance to a Member without finance access, wherever they land", () => {
    for (const at of ["finance", "finance/invoices/inv-7", "finance/settings"]) {
      const html = renderPageAt(at, "finance", h(FinanceLayout, { company: memberNoFinance }));
      // No Finance links: only the product Integrations page, which reads
      // Connections and so opens for any Member.
      assert.deepEqual(
        hrefsAndText(aside(html)),
        [{ href: "/c/acme/finance/integrations", text: "Integrations" }],
        at,
      );
      // The page, whose every read would answer 403, gives way to one note.
      assert.equal(html.includes(PAGE_TEXT), false, at);
      assert.ok(decode(html).includes("You don't have access to Finance"), at);
      assert.ok(html.includes("Settings → Members"), at);
    }
  });

  test("keeps Finance, rail and pages, open to anyone with Read access or more", () => {
    const rail = [
      ...expectedLinks("finance"),
      { href: "/c/acme/finance/integrations", text: "Integrations" },
    ];
    for (const c of [company, admin, member, memberReadOnly]) {
      for (const at of ["finance", "finance/invoices/inv-7"]) {
        const html = renderPageAt(at, "finance", h(FinanceLayout, { company: c }));
        const who = `${c.role}, ${c.financeAccess} at ${at}`;
        assert.deepEqual(hrefsAndText(aside(html)), rail, who);
        assert.ok(html.includes(PAGE_TEXT), who);
        assert.equal(decode(html).includes("have access to Finance"), false, who);
      }
    }
  });

  test("gives a Member without finance access a Customers rail of Contracts alone", () => {
    const html = renderAt(
      "customers/contracts",
      "customers/*",
      h(CustomersLayout, { company: memberNoFinance }),
    );
    assert.deepEqual(hrefsAndText(aside(html)), [
      { href: "/c/acme/customers/contracts", text: "Contracts" },
      { href: "/c/acme/customers/integrations", text: "Integrations" },
    ]);
  });
});
