import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let customer: Customer;

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

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `finance-owner-${randomUUID()}@example.com`,
    name: "Finance Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Customer deletion test",
    slug: `customer-delete-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Customer",
    slug: "acme-customer",
  });
});

async function deleteCustomer(): Promise<{
  status: number;
  body: { error?: string; ok?: boolean };
}> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/customers/${customer.slug}`,
    { method: "DELETE" },
  );
  return {
    status: response.status,
    body: (await response.json()) as { error?: string; ok?: boolean },
  };
}

type ListedCustomer = {
  id: string;
  name: string;
  archivedAt: string | null;
  contacts: Array<{ id: string; name: string; sortOrder: number }>;
};

type CustomerPage = {
  customers: ListedCustomer[];
  total: number;
  limit: number;
  offset: number;
};

async function getCustomers(query = ""): Promise<Response> {
  return fetch(`${baseUrl}/api/companies/${company.id}/customers${query}`);
}

async function readPage(query: string): Promise<CustomerPage> {
  const response = await getCustomers(query);
  assert.equal(response.status, 200);
  return (await response.json()) as CustomerPage;
}

async function insertCustomer(values: Partial<Customer> & Pick<Customer, "name" | "slug">) {
  return insert(Customer, { companyId: company.id, ...values });
}

describe("customer list", () => {
  test("preserves the legacy array response and hydrates contacts in display order", async () => {
    const later = await insert(CustomerContact, {
      companyId: company.id,
      customerId: customer.id,
      name: "Second contact",
      sortOrder: 2,
    });
    const earlier = await insert(CustomerContact, {
      companyId: company.id,
      customerId: customer.id,
      name: "First contact",
      sortOrder: 1,
    });
    await insertCustomer({
      name: "Archived customer",
      slug: "archived-customer",
      archivedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const response = await getCustomers("?archived=false");
    assert.equal(response.status, 200);
    const rows = (await response.json()) as ListedCustomer[];
    assert.ok(Array.isArray(rows));
    assert.deepEqual(
      rows.map((row) => row.name),
      ["Acme Customer"],
    );
    assert.deepEqual(
      rows[0].contacts.map((contact) => contact.id),
      [earlier.id, later.id],
    );

    const searched = await getCustomers("?q=acme");
    assert.equal(searched.status, 200);
    const searchedRows = (await searched.json()) as ListedCustomer[];
    assert.ok(Array.isArray(searchedRows));
    assert.deepEqual(
      searchedRows.map((row) => row.id),
      [customer.id],
    );
  });

  test("returns stable pages with the matching total and no overlap", async () => {
    await AppDataSource.getRepository(Customer).delete({ companyId: company.id });
    const sameNewest = new Date("2026-09-03T12:00:00.000Z");
    await insertCustomer({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Newest A",
      slug: "newest-a",
      createdAt: sameNewest,
    });
    await insertCustomer({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Newest B",
      slug: "newest-b",
      createdAt: sameNewest,
    });
    await insertCustomer({
      id: "00000000-0000-4000-8000-000000000003",
      name: "Middle",
      slug: "middle",
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
    });
    const sameOldest = new Date("2026-09-01T12:00:00.000Z");
    await insertCustomer({
      id: "00000000-0000-4000-8000-000000000004",
      name: "Oldest A",
      slug: "oldest-a",
      createdAt: sameOldest,
    });
    await insertCustomer({
      id: "00000000-0000-4000-8000-000000000005",
      name: "Oldest B",
      slug: "oldest-b",
      createdAt: sameOldest,
    });

    const first = await readPage("?limit=2");
    const second = await readPage("?limit=2&offset=2");
    const third = await readPage("?limit=2&offset=4");

    assert.deepEqual(
      [...first.customers, ...second.customers, ...third.customers].map((row) => row.name),
      ["Newest B", "Newest A", "Middle", "Oldest B", "Oldest A"],
    );
    assert.equal(new Set([...first.customers, ...second.customers].map((row) => row.id)).size, 4);
    assert.deepEqual(
      [first, second, third].map(({ total, limit, offset }) => ({ total, limit, offset })),
      [
        { total: 5, limit: 2, offset: 0 },
        { total: 5, limit: 2, offset: 2 },
        { total: 5, limit: 2, offset: 4 },
      ],
    );
  });

  test("searches every displayed customer and contact identity field case-tolerantly", async () => {
    customer.name = "Northwind Holdings";
    customer.domain = "northwind.example";
    customer.email = "BILLING@NORTHWIND.EXAMPLE";
    customer.phone = "+44 20 7946 0958";
    customer.taxNumber = "GB-VAT-ALPHA";
    await AppDataSource.getRepository(Customer).save(customer);
    await insert(CustomerContact, {
      companyId: company.id,
      customerId: customer.id,
      name: "Ada Lovelace",
      email: "ADA.CONTACT@EXAMPLE.COM",
      phone: "+1 555 0101",
      role: "Finance Director",
      sortOrder: 0,
    });
    await insertCustomer({ name: "Unrelated", slug: "unrelated" });

    for (const query of [
      "nOrThWiNd",
      "northwind.example",
      "billing@northwind",
      "7946 0958",
      "gb-vat-alpha",
      "lovelace ada",
      "ada.contact@example.com",
      "555 0101",
      "director finance",
      "northwind director",
    ]) {
      const page = await readPage(`?limit=10&q=${encodeURIComponent(`  ${query}  `)}`);
      assert.equal(page.total, 1, query);
      assert.deepEqual(
        page.customers.map((row) => row.id),
        [customer.id],
        query,
      );
    }
  });

  test("treats LIKE wildcard characters as literal search text", async () => {
    await AppDataSource.getRepository(Customer).delete({ companyId: company.id });
    const literal = await insertCustomer({
      name: "100%_Real Customer",
      slug: "literal-wildcard",
    });
    await insertCustomer({ name: "Ordinary Customer", slug: "ordinary" });

    for (const query of ["%", "_", "%_Real"]) {
      const page = await readPage(`?limit=10&q=${encodeURIComponent(query)}`);
      assert.equal(page.total, 1, query);
      assert.deepEqual(
        page.customers.map((row) => row.id),
        [literal.id],
        query,
      );
    }
  });

  test("excludes archived matches by default and includes them on request", async () => {
    customer.name = "Active Match";
    await AppDataSource.getRepository(Customer).save(customer);
    const archived = await insertCustomer({
      name: "Archived Match",
      slug: "archived-match",
      archivedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const activeOnly = await readPage("?q=match&limit=10");
    assert.deepEqual(
      activeOnly.customers.map((row) => row.id),
      [customer.id],
    );
    assert.equal(activeOnly.total, 1);

    const withArchived = await readPage("?q=match&archived=true&limit=10");
    assert.equal(withArchived.total, 2);
    assert.ok(withArchived.customers.some((row) => row.id === customer.id));
    assert.ok(withArchived.customers.some((row) => row.id === archived.id));
  });

  test("keeps both customer and contact matching inside the requested company", async () => {
    const foreignCompanyId = randomUUID();
    await insert(Customer, {
      companyId: foreignCompanyId,
      name: "Foreign Needle",
      slug: "foreign-needle",
    });
    // Even a corrupt cross-company reference must not turn the local Customer
    // into a contact-search match.
    await insert(CustomerContact, {
      companyId: foreignCompanyId,
      customerId: customer.id,
      name: "Leaked Needle",
      sortOrder: 0,
    });

    const page = await readPage("?q=needle&limit=10");
    assert.equal(page.total, 0);
    assert.deepEqual(page.customers, []);
  });

  test("counts a customer once when several contacts match", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insert(CustomerContact, {
        companyId: company.id,
        customerId: customer.id,
        name: `Finance contact ${index}`,
        role: "Finance",
        sortOrder: index,
      });
    }

    const page = await readPage("?q=finance&limit=1&offset=0");
    assert.equal(page.total, 1);
    assert.equal(page.customers.length, 1);
    assert.equal(page.customers[0].contacts.length, 3);
  });

  test("rejects malformed, unbounded, and unknown query parameters", async () => {
    const tooLong = "x".repeat(201);
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=no",
      "?offset=-1",
      "?offset=1.5",
      "?offset=no",
      "?offset=1e100",
      `?offset=${Number.MAX_SAFE_INTEGER + 1}`,
      "?archived=1",
      "?archived=yes",
      `?q=${tooLong}`,
      "?unknown=true",
    ]) {
      const response = await getCustomers(query);
      assert.equal(response.status, 400, query);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "ValidationError", query);
    }
  });

  test("returns an empty page but preserves the total past the last row", async () => {
    await insertCustomer({ name: "Second customer", slug: "second-customer" });
    const page = await readPage("?offset=200");
    assert.deepEqual(page.customers, []);
    assert.equal(page.total, 2);
    assert.equal(page.limit, 25);
    assert.equal(page.offset, 200);
  });
});

describe("customer hard deletion", () => {
  test("refuses to delete a customer linked to contract history", async () => {
    const contract = await insert(CustomerContract, {
      companyId: company.id,
      customerId: customer.id,
      title: "Signed services agreement",
      filename: "services-agreement.pdf",
      storageKey: `${randomUUID()}.pdf`,
      signedAt: new Date(),
      uploadedByUserId: company.ownerId,
    });

    const response = await deleteCustomer();
    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /signing history.*Archive it instead/);
    assert.ok(await AppDataSource.getRepository(Customer).findOneBy({ id: customer.id }));
    assert.equal(
      (await AppDataSource.getRepository(CustomerContract).findOneByOrFail({ id: contract.id }))
        .customerId,
      customer.id,
    );
  });

  test("refuses to delete a customer linked to a signature request", async () => {
    const envelope = await insert(SignatureEnvelope, {
      companyId: company.id,
      customerId: customer.id,
      title: "Pending services agreement",
      originalFilename: "services-agreement.pdf",
      originalStorageKey: `original-${randomUUID()}.pdf`,
      createdByUserId: company.ownerId,
    });

    const response = await deleteCustomer();
    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /signing history.*Archive it instead/);
    assert.ok(await AppDataSource.getRepository(Customer).findOneBy({ id: customer.id }));
    assert.equal(
      (await AppDataSource.getRepository(SignatureEnvelope).findOneByOrFail({ id: envelope.id }))
        .customerId,
      customer.id,
    );
  });

  test("still deletes a customer with no linked history", async () => {
    const response = await deleteCustomer();
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(await AppDataSource.getRepository(Customer).findOneBy({ id: customer.id }), null);
  });
});
