import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { Customer } from "../db/entities/Customer.js";
import { Estimate } from "../db/entities/Estimate.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../test/dbHarness.js";
import { hydrateEstimates } from "./estimates.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

test("hydrateEstimates includes the customer's billing address", async () => {
  const companyId = testCompanyId();
  const customer = await insert(Customer, {
    companyId,
    name: "BaFin",
    slug: "bafin",
    email: "billing@bafin.example",
    billingAddress: "Graurheindorfer Straße 108\n53117 Bonn\nGermany",
  });
  const estimate = await insert(Estimate, {
    companyId,
    customerId: customer.id,
    slug: "edraft-address",
    issueDate: new Date("2026-08-06T09:00:00.000Z"),
    validUntil: new Date("2026-09-05T09:00:00.000Z"),
  });

  const [hydrated] = await hydrateEstimates(companyId, [estimate]);

  assert.equal(hydrated.customer?.billingAddress, customer.billingAddress);
});
