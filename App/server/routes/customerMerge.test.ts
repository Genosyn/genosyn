import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { RevenueDuplicateCandidate } from "../db/entities/RevenueDuplicateCandidate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Merging duplicate customers from the Customers pages: the preview, the merge
 * itself, what a merged duplicate's page says afterwards, the duplicates the
 * scan found, and the domain rule a merge leaves behind (an archived duplicate
 * keeps its domain without blocking the customer that stayed).
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let duplicate: Customer;
let survivor: Customer;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", financeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function member(role: Role, financeAccess: FinanceAccess = "none"): Promise<User> {
  const user = await insert(User, {
    email: `customer-merge-${randomUUID()}@example.com`,
    name: `${role} member`,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role, financeAccess });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `customer-merge-owner-${randomUUID()}@example.com`,
    name: "Finance Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Merge test",
    slug: `merge-test-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  survivor = await insert(Customer, {
    companyId: company.id,
    name: "Whataburger",
    slug: "whataburger",
    domain: "wbhq.com",
    email: "ap@wbhq.com",
  });
  duplicate = await insert(Customer, {
    companyId: company.id,
    name: "Whataburger LLC",
    slug: "whataburger-llc",
    email: "billing@wbhq.com",
    phone: "+1 210 555 0100",
  });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { error?: string } }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const merge = (source: Customer, target: Customer, confirm = source.name, resolutions = {}) =>
  call("POST", `/customers/${source.slug}/merge`, {
    targetCustomerId: target.id,
    confirmSourceName: confirm,
    resolutions,
  });

const stored = (id: string) => AppDataSource.getRepository(Customer).findOneByOrFail({ id });

describe("merging a duplicate customer", () => {
  test("previews what moves and each value the two disagree on, changing nothing", async () => {
    await insert(CustomerContact, {
      companyId: company.id,
      customerId: duplicate.id,
      name: "Accounts payable",
      email: "ap-team@wbhq.com",
    });
    const preview = await call(
      "GET",
      `/customers/${duplicate.slug}/merge-preview?targetCustomerId=${survivor.id}`,
    );
    assert.equal(preview.status, 200);
    const counts = preview.body.counts as Record<string, number>;
    assert.equal(counts.billingContacts, 1);
    const fields = (preview.body.fieldConflicts as Array<{ field: string }>).map((c) => c.field);
    for (const field of ["name", "email", "phone", "domain"]) assert.ok(fields.includes(field), field);
    // A preview is a read.
    assert.equal((await stored(duplicate.id)).archivedAt, null);
    assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ action: "finance.customer.merge" }), 0);
  });

  test("moves everything into the customer kept, archives the duplicate, and both Histories say so", async () => {
    const billing = await insert(CustomerContact, {
      companyId: company.id,
      customerId: duplicate.id,
      name: "Accounts payable",
    });
    const person = await insert(Contact, {
      companyId: company.id,
      customerId: duplicate.id,
      name: "Rosa Perez",
      email: "roperez@wbhq.com",
      lifecycleStage: "lead",
      archivedAt: null,
    });

    const merged = await merge(duplicate, survivor, duplicate.name, { phone: "source" });
    assert.equal(merged.status, 200, merged.body.error);
    assert.equal((merged.body.target as { id: string }).id, survivor.id);

    assert.equal(
      (await AppDataSource.getRepository(CustomerContact).findOneByOrFail({ id: billing.id }))
        .customerId,
      survivor.id,
    );
    assert.equal(
      (await AppDataSource.getRepository(Contact).findOneByOrFail({ id: person.id })).customerId,
      survivor.id,
    );
    assert.ok((await stored(duplicate.id)).archivedAt, "the duplicate is archived, not deleted");
    const kept = await stored(survivor.id);
    assert.equal(kept.archivedAt, null);
    assert.equal(kept.phone, "+1 210 555 0100", "the chosen value came across");
    assert.equal(kept.email, "ap@wbhq.com", "unchosen conflicts keep the survivor's value");

    const history = await AppDataSource.getRepository(AuditEvent).find({
      where: { action: "finance.customer.merge", targetType: "customer" },
    });
    assert.deepEqual(history.map((row) => row.targetId).sort(), [duplicate.id, survivor.id].sort());

    // The duplicate's page points at where its history lives now, and it stays merged.
    const page = await call("GET", `/customers/${duplicate.slug}`);
    assert.deepEqual(page.body.mergedInto, {
      id: survivor.id,
      slug: survivor.slug,
      name: survivor.name,
    });
    assert.equal((await call("GET", `/customers/${survivor.slug}`)).body.mergedInto, null);
    const unarchive = await call("PATCH", `/customers/${duplicate.slug}`, { archived: false });
    assert.equal(unarchive.status, 409);
    assert.match(unarchive.body.error ?? "", /undo the merge instead/);
    const again = await merge(duplicate, survivor);
    assert.equal(again.status, 409, "a duplicate is merged once");
  });

  test("a merged duplicate's page follows a chain of merges to the end", async () => {
    const third = await insert(Customer, { companyId: company.id, name: "WB Holdings", slug: "wb-holdings" });
    assert.equal((await merge(duplicate, survivor)).status, 200);
    assert.equal((await merge(survivor, third)).status, 200);
    assert.equal(
      ((await call("GET", `/customers/${duplicate.slug}`)).body.mergedInto as { id: string }).id,
      third.id,
    );
  });

  test("refuses a mistyped name, a merge into itself, and an archived destination", async () => {
    const mistyped = await merge(duplicate, survivor, "Whataburger");
    assert.equal(mistyped.status, 409);
    assert.match(mistyped.body.error ?? "", /Type the source account name exactly/);

    const itself = await merge(duplicate, duplicate);
    assert.equal(itself.status, 409);

    await AppDataSource.getRepository(Customer).update(survivor.id, { archivedAt: new Date() });
    const archived = await merge(duplicate, survivor);
    assert.equal(archived.status, 409);
    assert.match(archived.body.error ?? "", /Restore the destination/);

    const unknown = await call("POST", `/customers/${duplicate.slug}/merge`, {
      targetCustomerId: randomUUID(),
      confirmSourceName: duplicate.name,
    });
    assert.equal(unknown.status, 404);
    assert.equal((await stored(duplicate.id)).archivedAt, null, "nothing was merged");
  });

  test("needs full finance access to merge; read access may preview", async () => {
    const reader = await member("member", "read");
    actingUserId = reader.id;
    const preview = await call(
      "GET",
      `/customers/${duplicate.slug}/merge-preview?targetCustomerId=${survivor.id}`,
    );
    assert.equal(preview.status, 200);
    const refused = await merge(duplicate, survivor);
    assert.equal(refused.status, 403);
    assert.equal((await stored(duplicate.id)).archivedAt, null);

    const outsider = await member("member", "none");
    actingUserId = outsider.id;
    assert.equal(
      (await call("GET", `/customers/${duplicate.slug}/merge-preview?targetCustomerId=${survivor.id}`))
        .status,
      403,
    );

    const keeper = await member("member", "full");
    actingUserId = keeper.id;
    assert.equal((await merge(duplicate, survivor)).status, 200);
  });

  test("rejects a malformed destination and unknown fields", async () => {
    const bad = await call("GET", `/customers/${duplicate.slug}/merge-preview?targetCustomerId=nope`);
    assert.equal(bad.status, 400);
    const extra = await call("POST", `/customers/${duplicate.slug}/merge`, {
      targetCustomerId: survivor.id,
      confirmSourceName: duplicate.name,
      deleteSource: true,
    });
    assert.equal(extra.status, 400);
    const missing = await call(
      "GET",
      `/customers/no-such-customer/merge-preview?targetCustomerId=${survivor.id}`,
    );
    assert.equal(missing.status, 404);
  });
});

describe("a domain belongs to one active customer", () => {
  test("a taken domain names the customer that has it, on create and on edit", async () => {
    const created = await call("POST", "/customers", { name: "WB again", domain: "WBHQ.com" });
    assert.equal(created.status, 409);
    assert.equal(created.body.error, "Whataburger already uses the domain wbhq.com");
    assert.deepEqual(created.body.conflict, {
      id: survivor.id,
      slug: survivor.slug,
      name: survivor.name,
    });

    const edited = await call("PATCH", `/customers/${duplicate.slug}`, { domain: "wbhq.com" });
    assert.equal(edited.status, 409);
    assert.deepEqual((edited.body.conflict as { id: string }).id, survivor.id);
    assert.equal((await stored(duplicate.id)).domain, "");

    // Saving a customer's own domain again is never a conflict.
    assert.equal((await call("PATCH", `/customers/${survivor.slug}`, { domain: "wbhq.com" })).status, 200);
  });

  test("after a merge, the customer kept saves the shared domain without tripping on the duplicate", async () => {
    // The duplicate is the older row, so a lookup that counted archived
    // customers would find it first and call the survivor's own domain taken.
    const older = await insert(Customer, {
      companyId: company.id,
      name: "Taco Cabana LLC",
      slug: "taco-cabana-llc",
      domain: "tacocabana.com",
    });
    const kept = await insert(Customer, {
      companyId: company.id,
      name: "Taco Cabana",
      slug: "taco-cabana",
      domain: "tacocabana.com",
    });
    assert.equal((await merge(older, kept)).status, 200);
    assert.equal((await stored(older.id)).domain, "tacocabana.com", "the duplicate keeps its history");
    const saved = await call("PATCH", `/customers/${kept.slug}`, {
      name: "Taco Cabana",
      domain: "tacocabana.com",
      email: "ap@tacocabana.com",
    });
    assert.equal(saved.status, 200, saved.body.error);
  });

  test("an archived customer's domain is free for an active one", async () => {
    await AppDataSource.getRepository(Customer).update(survivor.id, { archivedAt: new Date() });
    const created = await call("POST", "/customers", { name: "Whataburger Inc", domain: "wbhq.com" });
    assert.equal(created.status, 200, created.body.error);
    // And the archived one cannot come back onto it.
    const restored = await call("PATCH", `/customers/${survivor.slug}`, { archived: false });
    assert.equal(restored.status, 409);
    assert.match(restored.body.error ?? "", /Whataburger Inc already uses the domain wbhq\.com/);
  });
});

describe("the duplicates Revenue's scan found", () => {
  async function candidate(values: Partial<RevenueDuplicateCandidate> = {}) {
    return insert(RevenueDuplicateCandidate, {
      companyId: company.id,
      resourceType: "account",
      leftId: duplicate.id,
      rightId: survivor.id,
      score: 100,
      reasonsJson: JSON.stringify([{ kind: "normalized_name", value: "whataburger", score: 60 }]),
      status: "open",
      detectedAt: new Date(),
      ...values,
    });
  }

  test("are listed on both customers' pages, with why", async () => {
    const pair = await candidate();
    const fromDuplicate = await call("GET", `/customers/${duplicate.slug}/duplicates`);
    assert.equal(fromDuplicate.status, 200);
    assert.deepEqual(fromDuplicate.body, [
      {
        id: pair.id,
        score: 100,
        reasons: [{ kind: "normalized_name", value: "whataburger", score: 60 }],
        customer: {
          id: survivor.id,
          slug: survivor.slug,
          name: survivor.name,
          domain: "wbhq.com",
          email: "ap@wbhq.com",
        },
      },
    ]);
    const fromSurvivor = (await call("GET", `/customers/${survivor.slug}/duplicates`))
      .body as unknown as Array<{ customer: { id: string } }>;
    assert.deepEqual(
      fromSurvivor.map((row) => row.customer.id),
      [duplicate.id],
    );
  });

  test("leave out dismissed pairs, archived customers, other kinds of record, and other companies", async () => {
    const other = await insert(Customer, { companyId: company.id, name: "Elsewhere", slug: "elsewhere" });
    const archived = await insert(Customer, {
      companyId: company.id,
      name: "Old WB",
      slug: "old-wb",
      archivedAt: new Date(),
    });
    await candidate({ rightId: other.id, status: "dismissed" });
    await candidate({ rightId: archived.id });
    await candidate({ resourceType: "contact", rightId: other.id });
    await candidate({ companyId: randomUUID(), rightId: other.id });
    assert.deepEqual((await call("GET", `/customers/${duplicate.slug}/duplicates`)).body, []);
    // An archived customer's own page lists none.
    await candidate({ leftId: archived.id, rightId: survivor.id });
    assert.deepEqual((await call("GET", `/customers/${archived.slug}/duplicates`)).body, []);
  });

  test("Not a duplicate takes a pair off for good, and only from a page it belongs to", async () => {
    const pair = await candidate();
    const stranger = await insert(Customer, { companyId: company.id, name: "Stranger", slug: "stranger" });
    assert.equal(
      (await call("POST", `/customers/${stranger.slug}/duplicates/${pair.id}/dismiss`)).status,
      404,
    );
    assert.equal(
      (await call("POST", `/customers/${duplicate.slug}/duplicates/not-a-uuid/dismiss`)).status,
      404,
    );
    const reader = await member("member", "read");
    actingUserId = reader.id;
    assert.equal(
      (await call("POST", `/customers/${duplicate.slug}/duplicates/${pair.id}/dismiss`)).status,
      403,
    );
    actingUserId = (await member("admin")).id;
    const dismissed = await call("POST", `/customers/${duplicate.slug}/duplicates/${pair.id}/dismiss`);
    assert.equal(dismissed.status, 200);
    assert.equal(
      (await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneByOrFail({ id: pair.id }))
        .status,
      "dismissed",
    );
    assert.deepEqual((await call("GET", `/customers/${survivor.slug}/duplicates`)).body, []);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "revenue.duplicate.dismiss" }),
      1,
    );
  });

  test("a merge closes the pair it resolved", async () => {
    const pair = await candidate();
    assert.equal((await merge(duplicate, survivor)).status, 200);
    assert.equal(
      (await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneByOrFail({ id: pair.id }))
        .status,
      "merged",
    );
    assert.deepEqual((await call("GET", `/customers/${survivor.slug}/duplicates`)).body, []);
  });
});
