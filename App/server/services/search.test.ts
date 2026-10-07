import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
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
