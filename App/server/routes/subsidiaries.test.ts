import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Membership } from "../db/entities/Membership.js";
import { Subsidiary } from "../db/entities/Subsidiary.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { createSubsidiary, updateSubsidiary } from "../services/subsidiaries.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let customer: Customer;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: actingUserId, sessionVersion: 0 };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", financeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, { email: `owner-${randomUUID()}@example.com`, name: "Owner", passwordHash: "x", sessionVersion: 0 });
  actingUserId = owner.id;
  company = await insert(Company, { name: "Parent", slug: randomUUID(), ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  customer = await insert(Customer, { companyId: company.id, name: "Customer", slug: "customer" });
});

after(async () => {
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
  await closeTestDb();
});

function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("subsidiary administration requires an admin and reads respect finance access", async () => {
  const created = await request("/finance/subsidiaries", "POST", { name: " UK Limited ", taxNumber: "GB123" });
  assert.equal(created.status, 201);
  const subsidiary = await created.json() as Subsidiary;
  assert.equal(subsidiary.name, "UK Limited");
  const archived = await request(`/finance/subsidiaries/${subsidiary.id}`, "PATCH", { archived: true });
  assert.equal(archived.status, 200);
  const listed = await request("/finance/subsidiaries");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json() as Subsidiary[])[0].archived, true);

  const member = await insert(User, { email: `member-${randomUUID()}@example.com`, name: "Member", passwordHash: "x", sessionVersion: 0 });
  const membership = await insert(Membership, { companyId: company.id, userId: member.id, role: "member", financeAccess: "full" });
  actingUserId = member.id;
  assert.equal((await request("/finance/subsidiaries")).status, 200);
  assert.equal((await request("/finance/subsidiaries", "POST", { name: "Forbidden" })).status, 403);
  assert.equal((await request(`/finance/subsidiaries/${subsidiary.id}`, "PATCH", { archived: false })).status, 403);
  await AppDataSource.getRepository(Membership).update(membership.id, { financeAccess: "none" });
  assert.equal((await request("/finance/subsidiaries")).status, 403);
  await AppDataSource.getRepository(Membership).update(membership.id, { financeAccess: "read" });
  assert.equal((await request("/finance/subsidiaries")).status, 200);
});

test("subsidiary routes validate inputs and do not expose or change another company's profile", async () => {
  assert.equal((await request("/finance/subsidiaries", "POST", { name: "   " })).status, 400);
  assert.equal((await request("/finance/subsidiaries", "POST", { name: "UK", email: "invalid" })).status, 400);
  assert.equal((await request("/finance/subsidiaries/not-an-id", "PATCH", { name: "UK" })).status, 400);
  const foreign = await createSubsidiary(randomUUID(), { name: "Other company" });
  const response = await request(`/finance/subsidiaries/${foreign.id}`, "PATCH", { name: "Leaked" });
  assert.equal(response.status, 404);
  assert.deepEqual(await (await request("/finance/subsidiaries")).json(), []);
  assert.equal((await AppDataSource.getRepository(Subsidiary).findOneByOrFail({ id: foreign.id })).name, "Other company");
});

test("invoice and estimate issuer edits preserve unchanged snapshots and lock once issued", async () => {
  const first = await createSubsidiary(company.id, { name: "UK Ltd", footer: "UK bank" });
  const second = await createSubsidiary(company.id, { name: "US Inc", footer: "US bank" });
  const foreign = await createSubsidiary(randomUUID(), { name: "Foreign Ltd" });
  for (const path of ["invoices", "estimates"]) {
    const invalid = await request(`/${path}`, "POST", { customerId: customer.id, subsidiaryId: foreign.id });
    assert.equal(invalid.status, 400);
    const response = await request(`/${path}`, "POST", { customerId: customer.id, subsidiaryId: first.id });
    assert.equal(response.status, 200);
    const doc = await response.json() as Invoice | Estimate;
    assert.equal(doc.issuerSnapshot?.name, "UK Ltd");
    const changed = await request(`/${path}/${doc.slug}`, "PATCH", { subsidiaryId: second.id });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json() as Invoice).issuerSnapshot?.name, "US Inc");
    const invalidEdit = await request(`/${path}/${doc.slug}`, "PATCH", { subsidiaryId: foreign.id });
    assert.equal(invalidEdit.status, 400);
    const reset = await request(`/${path}/${doc.slug}`, "PATCH", { subsidiaryId: null });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json() as Invoice).issuerSnapshot, null);
    assert.equal((await request(`/${path}/${doc.slug}`, "PATCH", { subsidiaryId: first.id })).status, 200);
    await updateSubsidiary(company.id, first.id, { name: "Renamed UK", archived: true });
    const unchanged = await request(`/${path}/${doc.slug}`, "PATCH", { subsidiaryId: first.id, notes: "Updated notes" });
    assert.equal(unchanged.status, 200);
    assert.equal((await unchanged.json() as Invoice).issuerSnapshot?.name, "UK Ltd");
    if (path === "invoices") await AppDataSource.getRepository(Invoice).update(doc.id, { status: "sent" });
    else await AppDataSource.getRepository(Estimate).update(doc.id, { status: "sent" });
    assert.equal((await request(`/${path}/${doc.slug}`, "PATCH", { subsidiaryId: second.id })).status, 409);
    assert.equal((await request(`/${path}`, "POST", { customerId: customer.id, subsidiaryId: first.id })).status, 400);
    await updateSubsidiary(company.id, first.id, { name: "UK Ltd", archived: false });
  }
});

test("recurring invoice issuer selection validates company and archive boundaries", async () => {
  const issuer = await createSubsidiary(company.id, { name: "UK Ltd" });
  const foreign = await createSubsidiary(randomUUID(), { name: "Foreign Ltd" });
  const input = { customerId: customer.id, name: "Monthly", cronExpr: "0 9 1 * *", subsidiaryId: foreign.id };
  assert.equal((await request("/recurring-invoices", "POST", input)).status, 400);
  const created = await request("/recurring-invoices", "POST", { ...input, subsidiaryId: issuer.id });
  assert.equal(created.status, 200);
  const recurring = await created.json() as { slug: string; subsidiaryId: string };
  assert.equal(recurring.subsidiaryId, issuer.id);
  assert.equal((await request(`/recurring-invoices/${recurring.slug}`, "PATCH", { subsidiaryId: foreign.id })).status, 400);
  await updateSubsidiary(company.id, issuer.id, { archived: true });
  assert.equal((await request(`/recurring-invoices/${recurring.slug}`, "PATCH", { subsidiaryId: issuer.id, name: "Changed name" })).status, 200);
  assert.equal((await request("/recurring-invoices", "POST", { ...input, subsidiaryId: issuer.id })).status, 400);
});
