import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { exportInvoicesCsv } from "./exports.js";
import { createInvoiceDraft } from "./finance.js";
import { createSubsidiary, updateSubsidiary } from "./subsidiaries.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

test("invoice exports retain the saved legal issuer and label the company default", async () => {
  const company = await insert(Company, {
    name: "Parent Company",
    slug: "parent",
    ownerId: testId("owner"),
  });
  const customer = await insert(Customer, { companyId: company.id, name: "Customer", slug: "customer" });
  const subsidiary = await createSubsidiary(company.id, { name: 'Example, "UK" Ltd' });
  await createInvoiceDraft({
    companyId: company.id, customerId: customer.id, subsidiaryId: subsidiary.id,
    issueDate: new Date("2026-01-01T00:00:00.000Z"),
  });
  await createInvoiceDraft({
    companyId: company.id, customerId: customer.id,
    issueDate: new Date("2026-02-01T00:00:00.000Z"),
  });
  await updateSubsidiary(company.id, subsidiary.id, { name: "Renamed UK company", archived: true });

  const csv = await exportInvoicesCsv(company.id, null, null);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].endsWith(",Subsidiary ID,Issued by"));
  assert.ok(lines[1].endsWith(`,${subsidiary.id},"Example, ""UK"" Ltd"`));
  assert.ok(lines[2].endsWith(",,Parent Company"));
  assert.doesNotMatch(csv, /Renamed UK company/);
});
