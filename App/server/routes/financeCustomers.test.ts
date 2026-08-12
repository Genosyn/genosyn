import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
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
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
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
