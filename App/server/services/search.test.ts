import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { searchCompany } from "./search.js";

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
        query: "invoice",
      }),
      searchCompany({
        companyId: company.id,
        userId: "owner-1",
        role: "owner",
        query: "channel",
      }),
    ]);

    assert.ok(invoice.some((result) => result.id === "product:invoices"));
    assert.ok(invoice.some((result) => result.id === "product:recurring-invoices"));
    assert.ok(workspace.some((result) => result.id === "product:workspace"));
  });
});
