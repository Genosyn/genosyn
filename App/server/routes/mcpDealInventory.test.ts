import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Deal } from "../db/entities/Deal.js";
import { DealStage } from "../db/entities/DealStage.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "OneUptime", slug: "oneuptime", ownerId: "owner-1" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
    soulBody: "",
  });
  await insert(EmployeeRevenueGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function listDeals(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/list_deals`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { deals: Array<Record<string, unknown>>; total: number };
}

async function pipeline() {
  const stage = await insert(DealStage, {
    companyId: company.id,
    name: "Negotiation",
    slug: "negotiation",
    sortOrder: 0,
    probability: 70,
    kind: "open",
    archivedAt: null,
  });
  const account = await insert(Customer, {
    companyId: company.id,
    name: "Vuframe",
    slug: "vuframe",
    archivedAt: null,
  });
  const nextStep = `HOLD re-checked Oct 1: ${"Growth plan, 65 monitors still active. ".repeat(10)}`;
  await insert(Deal, {
    companyId: company.id,
    title: "Vuframe expansion",
    customerId: account.id,
    primaryContactId: null,
    stageId: stage.id,
    amountCents: 199_800,
    currency: "USD",
    status: "open",
    nextStep,
    archivedAt: null,
  });
  await insert(Deal, {
    companyId: company.id,
    title: "Inbound trial",
    customerId: null,
    primaryContactId: null,
    stageId: stage.id,
    amountCents: 0,
    currency: "USD",
    status: "open",
    archivedAt: null,
  });
  return { nextStep };
}

// 2026-10-01: Weekday Active Lead Follow-Up listed ~600 open Deals in pages of
// 200 and its context reached 85% of the local model's window in six steps.
test("a compact Deal inventory keeps what triage needs and drops the rest", async () => {
  const { nextStep } = await pipeline();
  const compact = await listDeals({ status: "open", compact: true });
  assert.equal(compact.total, 2);
  const expansion = compact.deals.find((row) => row.title === "Vuframe expansion")!;
  assert.equal(expansion.stageName, "Negotiation");
  assert.equal(expansion.customerName, "Vuframe");
  assert.equal(expansion.amountCents, 199_800);
  assert.equal(expansion.currency, "USD");
  assert.equal(expansion.nextStep, `${nextStep.slice(0, 160)}…`);
  for (const omitted of [
    "stageId",
    "customerId",
    "primaryContactId",
    "ownerId",
    "weightedValueCents",
  ])
    assert.equal(omitted in expansion, false, omitted);
  assert.equal(typeof expansion.id, "string", "the row still names the Deal to read in full");

  const trial = compact.deals.find((row) => row.title === "Inbound trial")!;
  assert.deepEqual(Object.keys(trial).sort(), ["id", "stageName", "status", "title"].sort());
});

test("a Deal listing without compact is unchanged", async () => {
  const { nextStep } = await pipeline();
  const full = await listDeals({ status: "open" });
  const expansion = full.deals.find((row) => row.title === "Vuframe expansion")!;
  assert.equal(expansion.nextStep, nextStep);
  assert.equal(typeof expansion.stageId, "string");
  assert.equal(typeof expansion.customerId, "string");
  assert.equal(expansion.closedAt, null);
  const compact = await listDeals({ status: "open", compact: true });
  assert.ok(
    JSON.stringify(compact.deals).length < JSON.stringify(full.deals).length / 2,
    "the compact page is less than half the size",
  );
});
