import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Estimate } from "../db/entities/Estimate.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../test/dbHarness.js";
import { hydrateEstimates, setEstimatesArchived } from "./estimates.js";

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

async function quote(companyId: string, values: Partial<Estimate> = {}): Promise<Estimate> {
  return insert(Estimate, {
    companyId,
    customerId: randomUUID(),
    slug: `edraft-${randomUUID().slice(0, 8)}`,
    issueDate: new Date("2026-10-01T09:00:00.000Z"),
    validUntil: new Date("2026-10-31T09:00:00.000Z"),
    ...values,
  });
}

const stored = (id: string) => AppDataSource.getRepository(Estimate).findOneByOrFail({ id });

test("setEstimatesArchived files estimates of any status away without touching their status", async () => {
  const companyId = testCompanyId();
  const draft = await quote(companyId);
  const sent = await quote(companyId, {
    slug: "acme-est-0001",
    number: "ACME-EST-0001",
    numberSeq: 1,
    status: "sent",
    sentAt: new Date("2026-10-01T09:05:00.000Z"),
  });
  const invoiced = await quote(companyId, { status: "accepted", invoiceId: randomUUID() });
  const voided = await quote(companyId, { status: "void" });

  const ids = [draft.id, sent.id, invoiced.id, voided.id];
  const { changed, skipped } = await setEstimatesArchived(companyId, ids, "archive");

  assert.deepEqual(
    changed.map((estimate) => estimate.id),
    ids,
  );
  assert.deepEqual(skipped, []);
  for (const before of [draft, sent, invoiced, voided]) {
    const after = await stored(before.id);
    assert.ok(after.archivedAt instanceof Date, `${before.status} is archived`);
    assert.equal(after.status, before.status);
    assert.equal(after.slug, before.slug);
    assert.equal(after.number, before.number);
    assert.equal(after.invoiceId, before.invoiceId);
  }
});

test("setEstimatesArchived skips foreign, missing, and already-archived ids with a reason", async () => {
  const companyId = testCompanyId();
  const active = await quote(companyId);
  const archivedAt = new Date("2026-10-02T10:00:00.000Z");
  const alreadyArchived = await quote(companyId, { archivedAt });
  const foreign = await quote(randomUUID());
  const missing = randomUUID();

  const { changed, skipped } = await setEstimatesArchived(
    companyId,
    [active.id, alreadyArchived.id, foreign.id, missing, active.id],
    "archive",
  );

  assert.deepEqual(
    changed.map((estimate) => estimate.id),
    [active.id],
    "a repeated id is archived once",
  );
  assert.deepEqual(skipped, [
    { id: alreadyArchived.id, reason: "Already archived" },
    { id: foreign.id, reason: "Estimate not found" },
    { id: missing, reason: "Estimate not found" },
  ]);
  assert.equal(
    (await stored(alreadyArchived.id)).archivedAt?.toISOString(),
    archivedAt.toISOString(),
    "re-archiving keeps the original timestamp",
  );
  assert.equal((await stored(foreign.id)).archivedAt, null, "another company's row is untouched");
});

test("setEstimatesArchived restores archived estimates and skips ones already in the list", async () => {
  const companyId = testCompanyId();
  const archived = await quote(companyId, {
    status: "declined",
    archivedAt: new Date("2026-10-02T10:00:00.000Z"),
  });
  const active = await quote(companyId);

  const { changed, skipped } = await setEstimatesArchived(
    companyId,
    [archived.id, active.id],
    "restore",
  );

  assert.deepEqual(
    changed.map((estimate) => estimate.id),
    [archived.id],
  );
  assert.deepEqual(skipped, [{ id: active.id, reason: "Not archived" }]);
  const restored = await stored(archived.id);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.status, "declined");
});
