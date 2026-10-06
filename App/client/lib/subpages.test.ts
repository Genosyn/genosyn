import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PRODUCT_INTEGRATION_KEYS } from "./productIntegrations.js";
import {
  ACCOUNT_SECTION,
  HELP_SECTION,
  SECTION_BY_KEY,
  SECTION_GROUPS,
  type SectionKey,
  searchSections,
} from "./sections.js";
import { MATCH_SCORE } from "./searchText.js";
import {
  PALETTE_SUBPAGES,
  PRODUCT_INTEGRATION_SUBPAGES,
  SECTION_SUBPAGES,
  SUBPAGE_RESULT_LIMIT,
  type SubpageItem,
  type SubpageViewer,
  canOpenSubpage,
  isCurrentSubpage,
  pagesLead,
  railSubpages,
  searchSubpages,
} from "./subpages.js";

const OWNER: SubpageViewer = { role: "owner", financeAccess: "full" };
const ADMIN: SubpageViewer = { role: "admin", financeAccess: "full" };
const MEMBER_FULL: SubpageViewer = { role: "member", financeAccess: "full" };
const MEMBER_READ: SubpageViewer = { role: "member", financeAccess: "read" };
const MEMBER_NONE: SubpageViewer = { role: "member", financeAccess: "none" };
const VIEWERS = { OWNER, ADMIN, MEMBER_FULL, MEMBER_READ, MEMBER_NONE };

/** What the palette lists as sections — the browse groups plus Help and Account. */
const PALETTE_SECTIONS = [...SECTION_GROUPS.flatMap((g) => g.items), HELP_SECTION, ACCOUNT_SECTION];

const ALL_PAGES: SubpageItem[] = [
  ...Object.values(SECTION_SUBPAGES).flatMap((pages) => pages ?? []),
  ...PRODUCT_INTEGRATION_SUBPAGES,
];

function page(path: string): SubpageItem {
  const found = ALL_PAGES.find((p) => p.path === path);
  assert.ok(found, `catalogue must list ${path}`);
  return found;
}

/** The palette's own pipeline: section matches first, then pages minus their paths. */
function palette(query: string, viewer: SubpageViewer = OWNER) {
  const sections = searchSections(PALETTE_SECTIONS, query);
  const pages = searchSubpages(PALETTE_SUBPAGES, query, {
    viewer,
    excludePaths: sections.map((m) => m.item.path),
  });
  return { sections, pages, pagesFirst: pagesLead(sections, pages) };
}

const paths = (matches: { page: SubpageItem }[]) => matches.map((m) => m.page.path);

// ─────────────────────────────── catalogue ───────────────────────────────

describe("subpage catalogue", () => {
  test("gives every page a unique, DOM-safe id and a unique destination", () => {
    const ids = ALL_PAGES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
    for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} must be DOM-safe`);
    const destinations = ALL_PAGES.map((p) => p.path);
    assert.equal(new Set(destinations).size, destinations.length, "paths must be unique");
  });

  test("keeps every page inside its own section's path", () => {
    for (const p of ALL_PAGES) {
      const base = SECTION_BY_KEY[p.section].path;
      assert.ok(base, `${p.id} belongs to a section with a path`);
      assert.ok(
        p.path === base || p.path.startsWith(`${base}/`) || p.path.startsWith(`${base}?`),
        `${p.path} must live under ${base}`,
      );
      assert.equal(p.path.startsWith("/"), true);
      assert.equal(/\/$/.test(p.path), false, `${p.path} must not end with a slash`);
    }
  });

  test("never catalogues Admin, which the palette deliberately leaves out", () => {
    assert.equal(SECTION_SUBPAGES.admin, undefined);
    assert.equal(
      PALETTE_SUBPAGES.some((p) => p.section === "admin" || p.path.startsWith("/admin")),
      false,
    );
  });

  test("labels read on their own and only differ from the rail where it is shorter", () => {
    for (const p of ALL_PAGES) {
      assert.equal(p.label, p.label.trim(), `${p.id} label is trimmed`);
      assert.ok(p.label.length > 0);
      if (p.navLabel !== undefined) {
        assert.notEqual(p.navLabel, p.label, `${p.id} navLabel must differ from its label`);
        assert.ok(p.navLabel.length > 0);
      }
      for (const keyword of p.keywords ?? []) {
        assert.equal(keyword, keyword.toLowerCase().trim(), `${p.id} keyword "${keyword}"`);
      }
    }
  });

  test("names the pages the rail calls something shorter by their full title", () => {
    assert.equal(page("/finance/recurring-invoices").label, "Recurring invoices");
    assert.equal(page("/finance/recurring-invoices").navLabel, "Recurring");
    assert.equal(page("/finance/accounts").label, "Chart of accounts");
    assert.equal(page("/finance/reconcile").label, "Reconciliation");
    assert.equal(page("/mail/settings").label, "Email settings");
    assert.equal(page("/tldrs/settings").label, "TLDR settings");
  });

  test("keeps each rail's group headings contiguous", () => {
    for (const section of Object.keys(SECTION_SUBPAGES) as SectionKey[]) {
      const groups = railSubpages(section).map((p) => p.navGroup ?? "");
      const seen: string[] = [];
      for (const group of groups) {
        if (seen.at(-1) === group) continue;
        assert.equal(seen.includes(group), false, `${section} rail repeats the "${group}" group`);
        seen.push(group);
      }
    }
  });

  test("returns only rail links from railSubpages, in catalogue order", () => {
    for (const [section, pages] of Object.entries(SECTION_SUBPAGES)) {
      const rail = railSubpages(section as SectionKey);
      assert.deepEqual(
        rail,
        (pages ?? []).filter((p) => p.rail),
      );
    }
    assert.deepEqual(railSubpages("home"), []);
    assert.deepEqual(railSubpages("admin"), []);
  });

  test("lists the Finance rail exactly as the sidebar draws it", () => {
    const rail = railSubpages("finance").map((p) => [p.navLabel ?? p.label, p.navGroup ?? ""]);
    assert.deepEqual(rail, [
      ["Overview", ""],
      ["Estimates", ""],
      ["Invoices", ""],
      ["Customer statements", ""],
      ["Credit notes", ""],
      ["Recurring", ""],
      ["Bills", ""],
      ["Vendors", ""],
      ["Vendor credits", ""],
      ["Transactions", "Ledger"],
      ["Journal", "Ledger"],
      ["Proposals", "Ledger"],
      ["Accounts", "Ledger"],
      ["Trial balance", "Ledger"],
      ["Reports", "Ledger"],
      ["Reconcile", "Ledger"],
      ["Card expenses", "Ledger"],
      ["Periods & exports", "Ledger"],
      ["Products", "Catalog"],
      ["Tax rates", "Catalog"],
      ["Currencies", "Catalog"],
      ["Templates", "Catalog"],
      ["Subsidiaries", "Catalog"],
      ["Settings", "Catalog"],
      ["AI access", "Catalog"],
    ]);
  });

  test("keeps create forms and self-drawn links out of the rails", () => {
    for (const path of [
      "/finance/invoices/new",
      "/finance/recurring-invoices/new",
      "/employees/new",
      "/routines/new",
      "/tasks/review",
      "/mail?view=drafts",
      "/settings/email/logs",
    ]) {
      assert.equal(page(path).rail, false, `${path} is not a catalogue-drawn rail link`);
    }
  });

  test("derives one Integrations page per product, ranked below the full catalog", () => {
    const integrationPaths = PRODUCT_INTEGRATION_KEYS.map((key) => `/${key}/integrations`);
    for (const path of integrationPaths) {
      const p = page(path);
      assert.equal(p.scoped, true, `${path} is a filtered view`);
      assert.equal(PALETTE_SUBPAGES.includes(p), true, `${path} is searchable`);
    }
    // Marketing's rail already names that page ("Connections"); it is not derived twice.
    assert.equal(page("/marketing/integrations").label, "Connections");
    assert.equal(
      PRODUCT_INTEGRATION_SUBPAGES.some((p) => p.path === "/marketing/integrations"),
      false,
    );
    assert.equal(page("/settings/integrations").scoped, false);
  });

  test("orders palette pages by section, then rail order, Integrations last", () => {
    const sectionOrder = Object.keys(SECTION_BY_KEY);
    let last = -1;
    for (const p of PALETTE_SUBPAGES) {
      const at = sectionOrder.indexOf(p.section);
      assert.ok(at >= last, `${p.id} is out of section order`);
      last = at;
    }
    const finance = PALETTE_SUBPAGES.filter((p) => p.section === "finance");
    assert.equal(finance.at(-1)?.path, "/finance/integrations");
    assert.equal(finance[0].path, "/finance");
  });

  test("offers every catalogued page to the palette exactly once", () => {
    assert.equal(PALETTE_SUBPAGES.length, ALL_PAGES.length);
    assert.equal(new Set(PALETTE_SUBPAGES).size, PALETTE_SUBPAGES.length);
    for (const p of ALL_PAGES) assert.ok(PALETTE_SUBPAGES.includes(p), `${p.id} missing`);
  });
});

// ─────────────────────────────── visibility ───────────────────────────────

describe("subpage visibility", () => {
  const plain = page("/settings/members");
  const adminOnly = page("/settings/audit");
  const financeRead = page("/finance/recurring-invoices");
  const financeFull = page("/finance/invoices/new");

  test("lets owners and admins open everything, whatever their membership row says", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const financeAccess of ["none", "read", "full", undefined] as const) {
        for (const p of ALL_PAGES) {
          assert.equal(canOpenSubpage(p, { role, financeAccess }), true, `${role} → ${p.id}`);
        }
      }
    }
  });

  test("keeps admin-only pages from Members", () => {
    assert.equal(canOpenSubpage(adminOnly, MEMBER_FULL), false);
    assert.equal(canOpenSubpage(plain, MEMBER_NONE), true);
  });

  test("applies Finance access levels to Members", () => {
    assert.equal(canOpenSubpage(financeRead, MEMBER_NONE), false);
    assert.equal(canOpenSubpage(financeRead, MEMBER_READ), true);
    assert.equal(canOpenSubpage(financeRead, MEMBER_FULL), true);
    assert.equal(canOpenSubpage(financeFull, MEMBER_NONE), false);
    assert.equal(canOpenSubpage(financeFull, MEMBER_READ), false);
    assert.equal(canOpenSubpage(financeFull, MEMBER_FULL), true);
  });

  test("fails closed for an unknown role or finance level", () => {
    assert.equal(canOpenSubpage(adminOnly, {}), false);
    assert.equal(canOpenSubpage(financeRead, {}), false);
    assert.equal(canOpenSubpage(financeRead, { role: "member" }), false);
    assert.equal(canOpenSubpage(plain, {}), true);
  });

  test("hides exactly the pages whose own reads or writes are admin-only", () => {
    // Each answers a Member with 403 — the read itself, or the only thing the
    // form is for. Pages a Member can open read-only are deliberately absent.
    const hidden = ALL_PAGES.filter((p) => !canOpenSubpage(p, MEMBER_FULL)).map((p) => p.path);
    assert.deepEqual(hidden.sort(), [
      "/employees/new",
      "/pipelines/new",
      "/routines/new",
      "/settings/audit",
      "/settings/email/logs",
      "/settings/sso",
      "/settings/usage",
      "/skills/new",
      "/vault/integrations",
    ]);
  });

  test("puts every Finance page behind Finance access, and create forms behind full", () => {
    for (const p of ALL_PAGES.filter((x) => x.section === "finance")) {
      if (p.path === "/finance/integrations") {
        // The Integrations view reads only Connections, which any Member may.
        assert.equal(p.access?.finance, undefined);
        continue;
      }
      const needed = p.path.endsWith("/new") ? "full" : "read";
      assert.equal(p.access?.finance, needed, `${p.path} needs finance ${needed}`);
    }
    assert.equal(page("/customers").access?.finance, "read");
    assert.equal(page("/customers/new").access?.finance, "full");
    assert.equal(page("/customers/contracts").access, undefined);
  });

  test("shows a finance-less Member no Finance pages, but the rest of the app", () => {
    const visible = PALETTE_SUBPAGES.filter((p) => canOpenSubpage(p, MEMBER_NONE));
    assert.deepEqual(
      visible.filter((p) => p.section === "finance").map((p) => p.path),
      ["/finance/integrations"],
    );
    assert.ok(visible.some((p) => p.path === "/customers/contracts"));
    assert.ok(visible.some((p) => p.path === "/revenue/deals"));
  });

  test("never returns a page the viewer cannot open, for any query", () => {
    const queries = [
      "a", "in", "new", "recurring", "settings", "integrations", "finance", "audit",
      "usage", "invoice", "employee", "routine", "bitwarden", "logs", "sso", "e",
    ];
    for (const [name, viewer] of Object.entries(VIEWERS)) {
      for (const query of queries) {
        for (const m of searchSubpages(PALETTE_SUBPAGES, query, { viewer, limit: 500 })) {
          assert.equal(canOpenSubpage(m.page, viewer), true, `${name} "${query}" → ${m.page.id}`);
        }
      }
    }
  });
});

// ─────────────────────────────── search ───────────────────────────────

describe("subpage search", () => {
  test('finds Recurring invoices for "recurring", alongside Routines', () => {
    const { sections, pages, pagesFirst } = palette("recurring");
    assert.equal(pages[0].page.path, "/finance/recurring-invoices");
    assert.equal(pages[0].score, MATCH_SCORE.prefix);
    assert.deepEqual(pages[0].hit, [0, 9]);
    assert.deepEqual(paths(pages), ["/finance/recurring-invoices", "/finance/recurring-invoices/new"]);
    assert.deepEqual(
      sections.map((m) => m.item.key),
      ["routines"],
      "Routines still answers to its synonym",
    );
    // The page is named for the query; Routines only lists it as a synonym.
    assert.equal(pagesFirst, true);
  });

  test('offers "recurring" by access: no create form at read, no pages at none', () => {
    assert.deepEqual(paths(palette("recurring", MEMBER_READ).pages), ["/finance/recurring-invoices"]);
    const none = palette("recurring", MEMBER_NONE);
    assert.deepEqual(none.pages, []);
    assert.equal(none.pagesFirst, false);
    assert.deepEqual(none.sections.map((m) => m.item.key), ["routines"]);
  });

  test("leads with the section when it is the better match", () => {
    const { sections, pages, pagesFirst } = palette("settings");
    assert.equal(sections[0].item.key, "settings");
    assert.equal(pagesFirst, false);
    // Pages named for the word lead; the section's own pages follow as context.
    assert.deepEqual(paths(pages).slice(0, 3), [
      "/tldrs/settings",
      "/mail/settings",
      "/finance/settings",
    ]);
    assert.equal(pages[3].page.section, "settings");
  });

  test("opens a page named exactly for the query ahead of its section", () => {
    const { pages, pagesFirst } = palette("members");
    assert.equal(pages[0].page.path, "/settings/members");
    assert.equal(pages[0].score, MATCH_SCORE.exact);
    assert.equal(pagesFirst, true);
  });

  test("lists a section's pages when only the section's name matches", () => {
    const { pages } = searchSubpagesFor("revenue", OWNER, ["/revenue"]);
    const parentOnly = pages.filter((m) => m.score === 50);
    assert.ok(parentOnly.length > 0);
    for (const m of parentOnly) assert.equal(m.page.section, "revenue");
    // Pages named for the word itself rank above pages that only share the section.
    assert.ok(pages[0].score > 50);
    assert.equal(pages[0].page.path, "/revenue/imports");
  });

  test("matches the parent section only at the start of a word", () => {
    // "count" sits inside "Account", but must not list the Account section's pages.
    const matches = searchSubpages(PALETTE_SUBPAGES, "count", { viewer: OWNER, limit: 500 });
    assert.equal(matches.some((m) => m.page.section === "account"), false);
  });

  test("treats a section named alongside a page as a qualifier, not a weak link", () => {
    const members = palette("settings members");
    assert.equal(members.pages[0].page.path, "/settings/members");
    assert.equal(members.pages[0].score, MATCH_SCORE.exact);
    assert.equal(members.pagesFirst, true);

    const accounts = palette("revenue accounts");
    assert.deepEqual(paths(accounts.pages), ["/revenue/accounts"], "not Chart of accounts");
  });

  test("requires every word to land somewhere", () => {
    assert.deepEqual(searchSubpages(PALETTE_SUBPAGES, "finance zebra", { viewer: OWNER }), []);
    assert.deepEqual(searchSubpages(PALETTE_SUBPAGES, "zebra", { viewer: OWNER }), []);
  });

  test("narrows with each extra word, in any order", () => {
    const both = paths(searchSubpages(PALETTE_SUBPAGES, "invoices recurring", { viewer: OWNER }));
    assert.deepEqual(both, ["/finance/recurring-invoices"]);
    const finance = paths(searchSubpages(PALETTE_SUBPAGES, "finance invoices", { viewer: OWNER }));
    assert.equal(finance[0], "/finance/invoices");
    assert.ok(finance.includes("/finance/recurring-invoices"));
  });

  test("ignores case, extra spaces, and accents", () => {
    for (const query of ["  RECURRING   INVOICES ", "récurring invoices", "Récurring Invoices"]) {
      const [top] = searchSubpages(PALETTE_SUBPAGES, query, { viewer: OWNER });
      assert.equal(top.page.path, "/finance/recurring-invoices", query);
      assert.equal(top.score, MATCH_SCORE.exact, query);
      assert.deepEqual(top.hit, [0, 18], query);
    }
  });

  test("highlights where a word inside the label matched", () => {
    const [top] = searchSubpages(PALETTE_SUBPAGES, "statements", { viewer: OWNER });
    assert.equal(top.page.path, "/finance/customer-statements");
    assert.equal(top.score, MATCH_SCORE.boundary);
    assert.deepEqual(top.hit, [9, 19]);
  });

  test("answers to the rail's shorter name without highlighting the title", () => {
    const [top] = searchSubpages(PALETTE_SUBPAGES, "reconcile", { viewer: OWNER });
    assert.equal(top.page.path, "/finance/reconcile");
    assert.equal(top.score, MATCH_SCORE.exact);
    assert.equal(top.hit, null);
  });

  test("answers to synonyms the product never prints", () => {
    const top = (q: string, viewer = OWNER) =>
      searchSubpages(PALETTE_SUBPAGES, q, { viewer })[0]?.page.path;
    assert.equal(top("p&l"), "/finance/reports");
    assert.equal(top("2fa"), "/account/security");
    assert.equal(top("bitwarden"), "/vault/integrations");
    assert.equal(top("bitwarden", MEMBER_FULL), undefined, "admin-only for Members");
    assert.equal(top("unsubscribes"), "/revenue/suppressions");
    assert.equal(top("subscriptions"), "/finance/recurring-invoices");
  });

  test("tolerates typos anchored to a word, but not scattered letters", () => {
    const rcrng = searchSubpages(PALETTE_SUBPAGES, "rcrng", { viewer: OWNER });
    assert.equal(rcrng[0].page.path, "/finance/recurring-invoices");
    assert.equal(rcrng[0].score, MATCH_SCORE.fuzzy);
    const newInv = paths(searchSubpages(PALETTE_SUBPAGES, "new inv", { viewer: OWNER }));
    assert.deepEqual(newInv, ["/finance/invoices/new", "/finance/recurring-invoices/new"]);
    // Two letters are too few to skip-match on.
    assert.equal(
      searchSubpages(PALETTE_SUBPAGES, "rg", { viewer: OWNER }).some(
        (m) => m.score === MATCH_SCORE.fuzzy,
      ),
      false,
    );
  });

  test("leads with the full Integrations catalog over its filtered views", () => {
    for (const viewer of [OWNER, MEMBER_NONE]) {
      const pages = searchSubpages(PALETTE_SUBPAGES, "integrations", { viewer });
      assert.equal(pages[0].page.path, "/settings/integrations");
      assert.equal(pages[0].score, MATCH_SCORE.exact);
      for (const m of pages.slice(1)) assert.equal(m.score, MATCH_SCORE.exact - 10, m.page.id);
    }
    const owner = paths(searchSubpages(PALETTE_SUBPAGES, "integrations", { viewer: OWNER, limit: 50 }));
    assert.ok(owner.includes("/vault/integrations"));
    const member = paths(
      searchSubpages(PALETTE_SUBPAGES, "integrations", { viewer: MEMBER_FULL, limit: 50 }),
    );
    assert.equal(member.includes("/vault/integrations"), false);
  });

  test("keeps catalogue order between equally good matches", () => {
    const aiAccess = paths(searchSubpages(PALETTE_SUBPAGES, "ai access", { viewer: OWNER }));
    const catalogueOrder = PALETTE_SUBPAGES.filter((p) => p.label === "AI access").map((p) => p.path);
    assert.deepEqual(aiAccess, catalogueOrder);
    assert.deepEqual(aiAccess, [
      "/meetings/ai-access",
      "/resources/ai-access",
      "/marketing/ai-access",
      "/revenue/ai-access",
      "/signatures/ai-access",
      "/finance/ai-access",
    ]);
    assert.equal(
      paths(searchSubpages(PALETTE_SUBPAGES, "ai access", { viewer: MEMBER_NONE })).includes(
        "/finance/ai-access",
      ),
      false,
    );
  });

  test("returns nothing for an empty query, so browsing stays the section list", () => {
    for (const query of ["", " ", "\t \n"]) {
      assert.deepEqual(searchSubpages(PALETTE_SUBPAGES, query, { viewer: OWNER }), []);
    }
  });

  test("caps the rows, and honours an explicit limit", () => {
    assert.equal(SUBPAGE_RESULT_LIMIT, 8);
    assert.equal(searchSubpages(PALETTE_SUBPAGES, "finance", { viewer: OWNER }).length, 8);
    assert.equal(searchSubpages(PALETTE_SUBPAGES, "finance", { viewer: OWNER, limit: 3 }).length, 3);
    assert.deepEqual(searchSubpages(PALETTE_SUBPAGES, "finance", { viewer: OWNER, limit: 0 }), []);
    const all = searchSubpages(PALETTE_SUBPAGES, "finance", { viewer: OWNER, limit: 500 });
    assert.ok(all.length > 25, "every Finance page answers to the section's name");
  });

  test("never lists the same destination twice", () => {
    const queries = ["a", "e", "in", "new", "settings", "integrations", "email", "finance", "ai"];
    for (const query of queries) {
      const result = paths(searchSubpages(PALETTE_SUBPAGES, query, { viewer: OWNER, limit: 500 }));
      assert.equal(new Set(result).size, result.length, query);
    }
    // Even if the catalogue were handed a duplicate, it is shown once.
    const twice = [page("/settings/members"), page("/settings/members")];
    assert.equal(searchSubpages(twice, "members", { viewer: OWNER }).length, 1);
  });

  test("drops a page that lands exactly where a listed section does", () => {
    const revenue = palette("revenue");
    assert.equal(revenue.sections[0].item.key, "revenue");
    assert.equal(paths(revenue.pages).includes("/revenue"), false, "Insights is Revenue");

    const insights = palette("insights");
    assert.deepEqual(paths(insights.pages), ["/revenue"], "Insights alone finds Revenue's page");
    assert.equal(insights.pagesFirst, true);

    // Trailing slashes don't hide a duplicate.
    const trailing = searchSubpages(PALETTE_SUBPAGES, "insights", {
      viewer: OWNER,
      excludePaths: ["/revenue/"],
    });
    assert.deepEqual(trailing, []);
  });

  test("never offers a section's landing page beside the section itself", () => {
    const queries = ["finance", "revenue", "meetings", "customers", "vault", "tldrs", "marketing"];
    for (const query of queries) {
      const { sections, pages } = palette(query);
      const sectionPaths = new Set(sections.map((m) => m.item.path));
      for (const m of pages) assert.equal(sectionPaths.has(m.page.path), false, `${query} → ${m.page.id}`);
    }
  });

  test("finds mail folders, admin-only logs, and create forms by name", () => {
    assert.deepEqual(paths(palette("drafts").pages), ["/mail?view=drafts"]);
    assert.equal(palette("email logs").pages[0].page.path, "/settings/email/logs");
    assert.equal(
      paths(palette("email logs", MEMBER_FULL).pages).includes("/settings/email/logs"),
      false,
    );
    assert.equal(palette("new invoice").pages[0].page.path, "/finance/invoices/new");
    assert.equal(palette("hire").pages[0].page.path, "/employees/new");
    assert.equal(paths(palette("hire", MEMBER_FULL).pages).includes("/employees/new"), false);
  });
});

describe("palette group order", () => {
  const section = (score: number) => ({ score });
  const pageMatch = (score: number) => ({ page: page("/settings/members"), hit: null, score });

  test("puts pages first only when they hold the strictly best match", () => {
    assert.equal(pagesLead([section(55)], [pageMatch(90)]), true);
    assert.equal(pagesLead([section(90)], [pageMatch(90)]), false, "ties keep sections first");
    assert.equal(pagesLead([section(100)], [pageMatch(80)]), false);
    assert.equal(pagesLead([], [pageMatch(20)]), true);
    assert.equal(pagesLead([section(20)], []), false);
    assert.equal(pagesLead([], []), false);
  });
});

describe("current page", () => {
  const recurring = page("/finance/recurring-invoices");
  const drafts = page("/mail?view=drafts");

  test("matches the exact path in the current company", () => {
    const at = (pathname: string, search = "") => ({ pathname, search });
    assert.equal(isCurrentSubpage(recurring, "acme", at("/c/acme/finance/recurring-invoices")), true);
    assert.equal(isCurrentSubpage(recurring, "acme", at("/c/acme/finance/recurring-invoices/")), true);
    assert.equal(
      isCurrentSubpage(recurring, "acme", at("/c/acme/finance/recurring-invoices", "?page=2")),
      true,
    );
    assert.equal(isCurrentSubpage(recurring, "acme", at("/c/other/finance/recurring-invoices")), false);
    assert.equal(
      isCurrentSubpage(recurring, "acme", at("/c/acme/finance/recurring-invoices/new")),
      false,
    );
    assert.equal(isCurrentSubpage(recurring, "acme", at("/c/acme/finance")), false);
  });

  test("requires a filtered view's parameters to match too", () => {
    const at = (search: string) => ({ pathname: "/c/acme/mail", search });
    assert.equal(isCurrentSubpage(drafts, "acme", at("?view=drafts")), true);
    assert.equal(isCurrentSubpage(drafts, "acme", at("?view=drafts&label=x")), true);
    assert.equal(isCurrentSubpage(drafts, "acme", at("?view=sent")), false);
    assert.equal(isCurrentSubpage(drafts, "acme", at("")), false);
  });
});

/** `searchSubpages` with the palette's section paths excluded. */
function searchSubpagesFor(query: string, viewer: SubpageViewer, excludePaths: string[]) {
  return { pages: searchSubpages(PALETTE_SUBPAGES, query, { viewer, excludePaths, limit: 500 }) };
}

// ─────────────────────────── Resources → AI access ───────────────────────────

describe("Resources in the catalogue", () => {
  test("draws the Resources rail as the library, then AI access", () => {
    assert.deepEqual(
      railSubpages("resources").map((p) => [p.navLabel ?? p.label, p.path]),
      [
        ["Library", "/resources"],
        ["AI access", "/resources/ai-access"],
      ],
    );
  });

  test("offers AI access to every Member, like the sibling AI access pages", () => {
    // Members can open the page and see who is read only; only owners and
    // admins can change it, which the page and its route enforce.
    const aiAccess = page("/resources/ai-access");
    assert.equal(aiAccess.access, undefined);
    for (const viewer of Object.values(VIEWERS)) assert.equal(canOpenSubpage(aiAccess, viewer), true);
    for (const sibling of ["/signatures/ai-access", "/revenue/ai-access", "/marketing/ai-access"]) {
      assert.equal(page(sibling).access, undefined, `${sibling} is ungated too`);
    }
  });

  test("finds Resources → AI access by its section, its name, and what it governs", () => {
    assert.equal(palette("resources ai access").pages[0].page.path, "/resources/ai-access");
    assert.ok(paths(palette("read only", MEMBER_NONE).pages).includes("/resources/ai-access"));
    assert.ok(paths(palette("who can edit resources").pages).includes("/resources/ai-access"));
  });

  test("never offers the library page beside the Resources section itself", () => {
    const { sections, pages } = palette("resources");
    assert.equal(sections[0].item.key, "resources");
    assert.equal(paths(pages).includes("/resources"), false);
  });
});
