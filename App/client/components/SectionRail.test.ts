import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import type { Company, Me } from "../lib/api.js";
import { productIntegrationScope } from "../lib/productIntegrations.js";
import { SECTION_BY_KEY, type SectionKey } from "../lib/sections.js";
import { SECTION_SUBPAGES, railSubpages } from "../lib/subpages.js";
import AccountLayout from "../pages/AccountLayout.js";
import CustomersLayout from "../pages/CustomersLayout.js";
import FinanceLayout from "../pages/FinanceLayout.js";
import MarketingLayout from "../pages/MarketingLayout.js";
import MeetingsLayout from "../pages/MeetingsLayout.js";
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

  test("draws nothing for a section without catalogued rail pages", () => {
    const html = renderAt(
      "workspace",
      "workspace/*",
      h(SectionRailLinks, { section: "workspace", companySlug: "acme" }),
    );
    assert.equal(html, "");
  });
});

describe("section layouts draw their rails from the catalogue", () => {
  const LAYOUTS: [SectionKey, string, React.ReactElement][] = [
    ["finance", "finance", h(FinanceLayout, { company })],
    ["revenue", "revenue", h(RevenueLayout, { company })],
    ["marketing", "marketing", h(MarketingLayout, { company })],
    ["meetings", "meetings", h(MeetingsLayout, { company })],
    ["customers", "customers", h(CustomersLayout, { company })],
    ["signatures", "signatures", h(SignatureLayout, { company })],
    ["tldrs", "tldrs", h(TldrsLayout, { company })],
    ["vault", "vault", h(VaultLayout, { company })],
  ];

  test("renders exactly the catalogue's rail, plus the product Integrations link", () => {
    for (const [section, at, element] of LAYOUTS) {
      const rail = links(aside(renderAt(at, `${SECTION_BY_KEY[section].path.slice(1)}/*`, element)));
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
});
