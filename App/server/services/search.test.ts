import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Product } from "../db/entities/Product.js";
import { Project } from "../db/entities/Project.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { Todo } from "../db/entities/Todo.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { searchCompany, type CompanySearchResult } from "./search.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

describe("company search product references", () => {
  test("returns stable product destinations even when the company has no rows there", async () => {
    const company = await insert(Company, {
      name: "Empty Co",
      slug: "empty-co",
      ownerId: "owner-1",
    });
    const results = await searchCompany({
      companyId: company.id,
      userId: "owner-1",
      role: "owner",
      financeAccess: "full",
      query: "estimate",
    });

    assert.equal(results[0]?.kind, "product");
    assert.equal(results[0]?.id, "product:estimates");
    assert.equal(results[0]?.path, "/finance/estimates");
    assert.match(results[0]?.sublabel ?? "", /quotation/i);
  });

  test("can return several independently selectable product hints", async () => {
    const company = await insert(Company, {
      name: "Empty Co",
      slug: "empty-co",
      ownerId: "owner-1",
    });
    const [invoice, workspace] = await Promise.all([
      searchCompany({
        companyId: company.id,
        userId: "owner-1",
        role: "owner",
        financeAccess: "full",
        query: "invoice",
      }),
      searchCompany({
        companyId: company.id,
        userId: "owner-1",
        role: "owner",
        financeAccess: "full",
        query: "channel",
      }),
    ]);

    assert.ok(invoice.some((result) => result.id === "product:invoices"));
    assert.ok(invoice.some((result) => result.id === "product:recurring-invoices"));
    assert.ok(workspace.some((result) => result.id === "product:workspace"));
  });
});

/**
 * The palette puts AI Employees first, and the response cap must never crowd
 * one out, so they lead the results whatever else matched.
 */
describe("company search puts AI Employees first", () => {
  test("employees lead records that match better or were touched more recently", async () => {
    const company = await insert(Company, {
      name: "Northwind",
      slug: "northwind",
      ownerId: "owner-1",
    });
    // An exact name, and a prefix match with a recent updatedAt: both used to
    // outrank an employee, who has no recency to break a tie with.
    await insert(Customer, { companyId: company.id, name: "Sam", slug: "sam" });
    await insert(Customer, { companyId: company.id, name: "SameSystem", slug: "samesystem" });
    await insert(AIEmployee, {
      companyId: company.id,
      name: "Samuel",
      slug: "samuel",
      role: "Account Executive",
    });
    // Matched by role alone, the weakest kind of hit, and still ahead.
    await insert(AIEmployee, {
      companyId: company.id,
      name: "Ada",
      slug: "ada",
      role: "Sam's chief of staff",
    });

    const results = await searchCompany({
      companyId: company.id,
      userId: "owner-1",
      role: "owner",
      financeAccess: "full",
      query: "sam",
    });

    assert.deepEqual(
      results.slice(0, 2).map((result) => [result.kind, result.label, result.path]),
      [
        ["employee", "Samuel", "/employees/samuel"],
        ["employee", "Ada", "/employees/ada"],
      ],
      "employees lead, the better match first",
    );
    assert.deepEqual(
      results.filter((result) => result.kind === "customer").map((result) => result.label),
      ["Sam", "SameSystem"],
      "everything else keeps its order beneath them",
    );
  });
});

/**
 * Every Finance page, and the customer list, is served by the finance routes,
 * so the ⌘K palette's Pages group never offers one to a Member with finance
 * access None. The product areas that open those pages follow the same rule,
 * in the palette and the chat # picker alike; every other area stays open.
 */
describe("company search product areas follow finance access", () => {
  /**
   * Each area that opens a page the finance routes serve, with the name
   * someone types to find it. Finance's landing and the customer list are
   * such pages too, though the palette lists their sections to everyone.
   */
  const FINANCE_AREAS: Record<string, string> = {
    customers: "Customers",
    finance: "Finance",
    estimates: "Estimates",
    invoices: "Invoices",
    "recurring-invoices": "Recurring invoices",
    products: "Products & services",
    bills: "Bills",
    transactions: "Entry review",
    "finance-reports": "Finance reports",
    reconciliation: "Banking",
  };
  let companyId: string;

  beforeEach(async () => {
    const company = await insert(Company, {
      name: "Empty Co",
      slug: "empty-co",
      ownerId: "owner-1",
    });
    companyId = company.id;
  });

  /** The product areas offered to this viewer, as catalogue keys in rank order. */
  async function areasFor(
    role: Role,
    financeAccess: FinanceAccess | undefined,
    query: string,
  ): Promise<string[]> {
    const results = await searchCompany({
      companyId,
      userId: `${role}-1`,
      role,
      financeAccess,
      query,
    });
    return results.flatMap((result) =>
      result.kind === "product" ? [result.id.replace(/^product:/, "")] : [],
    );
  }

  /** Searched by its own name, each Finance area comes first. */
  async function assertOffersEveryFinanceArea(
    role: Role,
    financeAccess: FinanceAccess,
  ): Promise<void> {
    for (const [key, name] of Object.entries(FINANCE_AREAS)) {
      const offered = await areasFor(role, financeAccess, name);
      assert.equal(offered[0], key, `${role} with ${financeAccess}: ${name}`);
    }
  }

  test("owners and admins are offered every Finance area even when their membership row says None", async () => {
    for (const role of ["owner", "admin"] as const) {
      await assertOffersEveryFinanceArea(role, "none");
    }
  });

  test("Full and Read-only Members are offered every Finance area", async () => {
    for (const financeAccess of ["full", "read"] as const) {
      await assertOffersEveryFinanceArea("member", financeAccess);
    }
  });

  test("a Member with None is offered no Finance area, and the areas they can open keep their places", async () => {
    const financeKeys = new Set(Object.keys(FINANCE_AREAS));
    // A membership without a level fails closed, as every finance route does.
    for (const financeAccess of ["none", undefined] as const) {
      const label = financeAccess ?? "no level";
      for (const query of ["invoice", "estimate", ...Object.values(FINANCE_AREAS)]) {
        const offered = await areasFor("member", financeAccess, query);
        assert.deepEqual(
          offered.filter((key) => financeKeys.has(key)),
          [],
          `${label}: ${query}`,
        );
      }
      assert.deepEqual(await areasFor("member", financeAccess, "channel"), ["workspace"], label);
      // Products, Estimates, and Finance reports outrank Signals for "pro".
      // They are left out before the five-area cap, so Signals still makes it.
      assert.deepEqual(
        await areasFor("member", financeAccess, "pro"),
        ["projects", "contacts", "signals"],
        label,
      );
    }
    // A reader is offered the top five, which leaves Signals out.
    assert.deepEqual(await areasFor("member", "read", "pro"), [
      "products",
      "projects",
      "contacts",
      "estimates",
      "finance-reports",
    ]);
  });
});

/**
 * Customers are served by the finance routes, which refuse a Member with
 * finance access None. Search must not hand that Member a customer page they
 * can't open, nor the billing email that page would have shown them.
 */
describe("company search customer hits follow finance access", () => {
  let companyId: string;
  let acme: Customer;

  beforeEach(async () => {
    const company = await insert(Company, {
      name: "Northwind",
      slug: "northwind",
      ownerId: "owner-1",
    });
    companyId = company.id;
    acme = await insert(Customer, {
      companyId,
      name: "Acme Corp",
      slug: "acme-corp",
      email: "payables@acme-billing.test",
      domain: "acme.io",
      industry: "Robotics",
    });
    // Archived accounts stay out of both views.
    await insert(Customer, {
      companyId,
      name: "Acme Legacy",
      slug: "acme-legacy",
      email: "old@acme-billing.test",
      domain: "legacy.acme.io",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  /** Search as a viewer whose membership row carries `financeAccess`. */
  async function hitsFor(
    role: Role,
    financeAccess: FinanceAccess | undefined,
    query: string,
  ): Promise<CompanySearchResult[]> {
    const results = await searchCompany({
      companyId,
      userId: `${role}-1`,
      role,
      financeAccess,
      query,
    });
    return results.filter((result) => result.kind === "customer" || result.kind === "account");
  }

  function customerHit(): CompanySearchResult {
    return {
      kind: "customer",
      id: acme.id,
      label: "Acme Corp",
      sublabel: "payables@acme-billing.test",
      path: "/customers/acme-corp",
    };
  }

  test("owners and admins open the customer even when their membership row says None", async () => {
    for (const role of ["owner", "admin"] as const) {
      for (const financeAccess of ["none", undefined] as const) {
        const label = `${role} with ${financeAccess ?? "no level"}`;
        assert.deepEqual(await hitsFor(role, financeAccess, "acme"), [customerHit()], label);
        assert.deepEqual(await hitsFor(role, financeAccess, "payables"), [customerHit()], label);
      }
    }
  });

  test("Full and Read-only Members open the customer, billing email included", async () => {
    for (const financeAccess of ["full", "read"] as const) {
      assert.deepEqual(await hitsFor("member", financeAccess, "acme"), [customerHit()], financeAccess);
      assert.deepEqual(
        await hitsFor("member", financeAccess, "payables"),
        [customerHit()],
        financeAccess,
      );
    }
  });

  test("a Member with None gets the Revenue account, never the billing email", async () => {
    // A membership without a level fails closed, as every finance route does.
    for (const financeAccess of ["none", undefined] as const) {
      const label = financeAccess ?? "no level";
      const account: CompanySearchResult = {
        kind: "account",
        id: acme.id,
        label: "Acme Corp",
        sublabel: "acme.io",
        path: `/revenue/accounts/${acme.id}`,
      };
      assert.deepEqual(await hitsFor("member", financeAccess, "acme"), [account], label);
      // Found by its domain, as Revenue → Accounts finds it.
      assert.deepEqual(await hitsFor("member", financeAccess, "acme.io"), [account], label);

      // The billing email is neither shown nor searchable: a match alone would
      // tie the address to the account.
      assert.deepEqual(await hitsFor("member", financeAccess, "payables"), [], label);
      const everything = await searchCompany({
        companyId,
        userId: "member-1",
        role: "member",
        financeAccess,
        query: "acme",
      });
      assert.ok(!JSON.stringify(everything).includes("acme-billing.test"), label);
      assert.ok(!everything.some((result) => result.path.startsWith("/customers")), label);
    }
  });

  test("a None Member's account reads as Revenue → Accounts describes it", async () => {
    await insert(Customer, { companyId, name: "Acme Labs", slug: "acme-labs", industry: "Biotech" });
    await insert(Customer, { companyId, name: "Acme Holdings", slug: "acme-holdings" });
    const hits = await hitsFor("member", "none", "acme");
    // Domain, else industry — what each card on Revenue → Accounts shows.
    assert.deepEqual(Object.fromEntries(hits.map((hit) => [hit.label, hit.sublabel])), {
      "Acme Corp": "acme.io",
      "Acme Labs": "Biotech",
      "Acme Holdings": null,
    });
  });
});

/**
 * A kind word is a qualifier, not a title token. "revenue dashboard" asks for
 * the Dashboard whose title says revenue — requiring both words in the title
 * made an exact dashboard name unreachable from the phrase people actually
 * type.
 */
describe("company search treats a kind word as a qualifier", () => {
  let companyId: string;

  beforeEach(async () => {
    const company = await insert(Company, {
      name: "Northwind",
      slug: "northwind",
      ownerId: "owner-1",
    });
    companyId = company.id;
    await insert(Dashboard, { companyId, title: "Revenue", slug: "revenue" });
    await insert(Dashboard, { companyId, title: "Pipeline", slug: "pipeline" });
    await insert(Chart, { companyId, title: "Revenue", slug: "revenue-chart" });
    const employee = await insert(AIEmployee, {
      companyId,
      name: "Ada",
      slug: "ada",
      role: "Analyst",
    });
    await insert(Skill, {
      employeeId: employee.id,
      name: "Revenue analysis",
      slug: "revenue-analysis",
    });
    await insert(Routine, {
      employeeId: employee.id,
      name: "Revenue review",
      slug: "revenue-review",
      cronExpr: "0 9 * * *",
    });
    const notebook = await insert(Notebook, {
      companyId,
      title: "Handbook",
      slug: "handbook",
    });
    await insert(Note, {
      companyId,
      notebookId: notebook.id,
      title: "Revenue notes",
      slug: "revenue-notes",
    });
    const project = await insert(Project, {
      companyId,
      name: "Revenue rollout",
      slug: "revenue-rollout",
      key: "REV",
    });
    await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Revenue review",
    });
  });

  async function search(query: string): Promise<CompanySearchResult[]> {
    return searchCompany({
      companyId,
      userId: "owner-1",
      role: "owner",
      financeAccess: "full",
      query,
    });
  }

  test("finds a Dashboard called Revenue by 'revenue dashboard'", async () => {
    const hits = await search("revenue dashboard");
    const dashboards = hits.filter((hit) => hit.kind === "dashboard");
    assert.deepEqual(
      dashboards.map((hit) => [hit.label, hit.path]),
      [["Revenue", "/explore/dashboards/revenue"]],
    );
    assert.equal(
      hits.some((hit) => hit.kind === "chart"),
      false,
      "the dashboard word does not pull in charts",
    );
  });

  test("answers the same way whichever order the words arrive in", async () => {
    const hits = await search("dashboard revenue");
    assert.ok(hits.some((hit) => hit.kind === "dashboard" && hit.label === "Revenue"));
  });

  test("keeps each kind word with its own kind", async () => {
    const charts = await search("revenue chart");
    assert.deepEqual(
      charts.filter((hit) => hit.kind === "chart").map((hit) => hit.label),
      ["Revenue"],
    );
    assert.equal(
      charts.some((hit) => hit.kind === "dashboard"),
      false,
      "a chart word does not list dashboards",
    );
  });

  test("a kind word on its own lists that kind", async () => {
    const hits = await search("dashboards");
    assert.deepEqual(
      hits.filter((hit) => hit.kind === "dashboard").map((hit) => hit.label).sort(),
      ["Pipeline", "Revenue"],
    );
  });

  test("still requires the remaining words to match the title", async () => {
    assert.equal(
      (await search("revenue quarterly dashboard")).some((hit) => hit.kind === "dashboard"),
      false,
    );
  });

  test("applies the same rule to the kinds with their own queries", async () => {
    const cases: Array<[query: string, kind: CompanySearchResult["kind"], label: string]> = [
      ["revenue skill", "skill", "Revenue analysis"],
      ["revenue routine", "routine", "Revenue review"],
      ["revenue notes", "note", "Revenue notes"],
      ["revenue project", "project", "Revenue rollout"],
      ["revenue tasks", "todo", "Revenue review"],
    ];
    for (const [query, kind, label] of cases) {
      const hits = await search(query);
      assert.ok(
        hits.some((hit) => hit.kind === kind && hit.label === label),
        `${query} should find ${kind} ${label}`,
      );
    }
  });

  test("a kind word alone lists the bespoke kinds too", async () => {
    const notes = await search("notes");
    assert.deepEqual(
      notes.filter((hit) => hit.kind === "note").map((hit) => hit.label),
      ["Revenue notes"],
    );
    const tasks = await search("tasks");
    assert.deepEqual(
      tasks.filter((hit) => hit.kind === "todo").map((hit) => hit.label),
      ["Revenue review"],
    );
  });

  test("a title that says the whole phrase leads one that says it without the kind word", async () => {
    // Inserted first, so recency would favour the shorter title on a tie.
    await insert(Dashboard, { companyId, title: "Sales dashboard", slug: "sales-dashboard" });
    await insert(Dashboard, { companyId, title: "Sales", slug: "sales" });
    for (const query of ["sales dashboard", "SALES DASHBOARD", "  sales   dashboard "]) {
      const hits = await search(query);
      assert.deepEqual(
        hits.filter((hit) => hit.kind === "dashboard").map((hit) => hit.label),
        ["Sales dashboard", "Sales"],
        query,
      );
    }
  });

  test("a name that matches once the kind word is set aside still leads looser titles", async () => {
    await insert(Dashboard, {
      companyId,
      title: "Revenue dashboard archive",
      slug: "revenue-dashboard-archive",
    });
    await insert(Dashboard, {
      companyId,
      title: "Old revenue dashboard",
      slug: "old-revenue-dashboard",
    });
    const hits = await search("revenue dashboard");
    assert.deepEqual(
      hits.filter((hit) => hit.kind === "dashboard").map((hit) => hit.label),
      ["Revenue", "Revenue dashboard archive", "Old revenue dashboard"],
    );
  });

  test("the whole phrase also wins when the kind word comes first", async () => {
    await insert(Dashboard, { companyId, title: "Dashboard revenue", slug: "dashboard-revenue" });
    const hits = await search("dashboard revenue");
    assert.deepEqual(
      hits.filter((hit) => hit.kind === "dashboard").map((hit) => hit.label),
      ["Dashboard revenue", "Revenue"],
    );
  });

  test("a kind word alone keeps the names that say it, however many rows the kind holds", async () => {
    // "data" starts "database", so it lists Bases. The Base whose name says
    // data must still be among the rows each kind fetches for ranking, not
    // pushed out by twenty-five names that sort ahead of it.
    await insert(Base, { companyId, name: "Marketing data", slug: "marketing-data" });
    for (let i = 1; i <= 25; i += 1) {
      const n = String(i).padStart(2, "0");
      await insert(Base, { companyId, name: `Archive ${n}`, slug: `archive-${n}` });
    }
    const hits = await search("data");
    const bases = hits.filter((hit) => hit.kind === "base").map((hit) => hit.label);
    assert.equal(bases[0], "Marketing data");
    assert.equal(bases.length, 5, "the rest of the kind still fills its places");
  });

  test("a name that starts with the kind word leads one that only contains it", async () => {
    await insert(Base, { companyId, name: "Marketing data", slug: "marketing-data" });
    await insert(Base, { companyId, name: "Data room index", slug: "data-room-index" });
    for (let i = 1; i <= 25; i += 1) {
      const n = String(i).padStart(2, "0");
      await insert(Base, { companyId, name: `Archive ${n}`, slug: `archive-${n}` });
    }
    const bases = (await search("data"))
      .filter((hit) => hit.kind === "base")
      .map((hit) => hit.label);
    assert.deepEqual(bases.slice(0, 2), ["Data room index", "Marketing data"]);
  });

  test("the kinds with their own queries keep those names in reach too", async () => {
    const notebook = await insert(Notebook, { companyId, title: "Site", slug: "site" });
    // Written first, so every newer note sorts ahead of it on recency alone.
    await insert(Note, {
      companyId,
      notebookId: notebook.id,
      title: "Pricing page",
      slug: "pricing-page",
    });
    for (let i = 1; i <= 25; i += 1) {
      const n = String(i).padStart(2, "0");
      await insert(Note, {
        companyId,
        notebookId: notebook.id,
        title: `Archive ${n}`,
        slug: `archive-${n}`,
      });
    }
    const hits = await search("page");
    const notes = hits.filter((hit) => hit.kind === "note").map((hit) => hit.label);
    assert.equal(notes[0], "Pricing page");
  });

  test("an ordinary query still ranks only the rows that match it", async () => {
    await insert(Base, { companyId, name: "Marketing data", slug: "marketing-data" });
    await insert(Base, { companyId, name: "Archive 01", slug: "archive-01" });
    const bases = (await search("marketing"))
      .filter((hit) => hit.kind === "base")
      .map((hit) => hit.label);
    assert.deepEqual(bases, ["Marketing data"]);
  });
});

/**
 * Finance products are records, not the Products & services area. Their names
 * should be searchable like any other record — and only by someone who can
 * open the catalogue.
 */
describe("company search finds Finance products by name", () => {
  let companyId: string;
  let starter: Product;

  beforeEach(async () => {
    const company = await insert(Company, {
      name: "Northwind",
      slug: "northwind",
      ownerId: "owner-1",
    });
    companyId = company.id;
    starter = await insert(Product, {
      companyId,
      name: "Starter plan",
      slug: "starter-plan",
      description: "Monthly plan for small teams",
      unitPriceCents: 4900,
      currency: "USD",
    });
    await insert(Product, {
      companyId,
      name: "Growth plan",
      slug: "growth-plan",
      description: "For teams that need more seats",
    });
    await insert(Product, {
      companyId,
      name: "Starter plan (legacy)",
      slug: "starter-plan-legacy",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const other = await insert(Company, {
      name: "Other Co",
      slug: "other-co",
      ownerId: "owner-2",
    });
    await insert(Product, {
      companyId: other.id,
      name: "Starter plan",
      slug: "starter-plan",
    });
  });

  async function hitsFor(
    role: Role,
    financeAccess: FinanceAccess | undefined,
    query: string,
  ): Promise<CompanySearchResult[]> {
    const results = await searchCompany({
      companyId,
      userId: `${role}-1`,
      role,
      financeAccess,
      query,
    });
    return results.filter((result) => result.kind === "catalogProduct");
  }

  test("returns the product with a link to the catalogue filtered to it", async () => {
    const [hit] = await hitsFor("owner", "none", "starter plan");
    assert.deepEqual(hit, {
      kind: "catalogProduct",
      id: starter.id,
      label: "Starter plan",
      sublabel: "Monthly plan for small teams",
      path: "/finance/products?q=Starter%20plan",
    });
  });

  test("matches every word across the name and description", async () => {
    assert.deepEqual(
      (await hitsFor("owner", "full", "small teams")).map((hit) => hit.label),
      ["Starter plan"],
    );
    assert.deepEqual(
      (await hitsFor("owner", "full", "plan")).map((hit) => hit.label).sort(),
      ["Growth plan", "Starter plan"],
    );
  });

  test("leaves archived products, and other companies' products, out", async () => {
    const hits = await hitsFor("owner", "full", "starter");
    assert.deepEqual(
      hits.map((hit) => hit.label),
      ["Starter plan"],
    );
  });

  test("Full and Read-only Members may open the catalogue and see its products", async () => {
    for (const financeAccess of ["full", "read"] as const) {
      assert.deepEqual(
        (await hitsFor("member", financeAccess, "starter")).map((hit) => hit.label),
        ["Starter plan"],
        financeAccess,
      );
    }
  });

  test("a Member with None never sees a product name", async () => {
    for (const financeAccess of ["none", undefined] as const) {
      const label = financeAccess ?? "no level";
      assert.deepEqual(await hitsFor("member", financeAccess, "starter"), [], label);
      const everything = await searchCompany({
        companyId,
        userId: "member-1",
        role: "member",
        financeAccess,
        query: "starter",
      });
      assert.equal(JSON.stringify(everything).includes("Starter plan"), false, label);
    }
  });

  test("owners and admins see products even when their membership row says None", async () => {
    for (const role of ["owner", "admin"] as const) {
      assert.deepEqual(
        (await hitsFor(role, "none", "starter")).map((hit) => hit.label),
        ["Starter plan"],
        role,
      );
    }
  });

  test("still offers the Products & services area itself", async () => {
    const hits = await searchCompany({
      companyId,
      userId: "owner-1",
      role: "owner",
      financeAccess: "full",
      query: "products",
    });
    assert.ok(hits.some((hit) => hit.kind === "product" && hit.id === "product:products"));
  });
});
