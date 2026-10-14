import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { employeesRouter } from "./employees.js";

/**
 * The roster says which AI Employees can answer in Chat, so the New routine
 * page can offer only those to hand a request to. Chat is not tied to the
 * active model: one connected model anywhere on the employee is enough, which
 * is what separates `chatReady` from the active model's `status` beside it.
 */

let server: Server;
let baseUrl: string;
let actingUserId = "";
let companyId = "";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: actingUserId, sessionVersion: 0 };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/employees", employeesRouter);
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
  const member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = member.id;
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  companyId = company.id;
  await insert(Membership, { companyId, userId: member.id, role: "member" });
});

const hire = (name: string) =>
  insert(AIEmployee, { companyId, name, slug: name.toLowerCase(), role: "Analyst", soulBody: "" });

const connected = JSON.stringify({ apiKeyEncrypted: "test-only-key" });

function model(employeeId: string, isActive: boolean, configJson: string) {
  return insert(AIModel, {
    employeeId,
    provider: "openai",
    model: isActive ? "active" : "spare",
    authMode: "apikey",
    isActive,
    configJson,
  });
}

type RosterRow = {
  name: string;
  chatReady: boolean;
  model: { status: string } | null;
};

async function roster(): Promise<Map<string, RosterRow>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/employees`);
  assert.equal(response.status, 200);
  const rows = (await response.json()) as RosterRow[];
  return new Map(rows.map((row) => [row.name, row]));
}

test("an employee can chat when any model is connected, and not otherwise", async () => {
  const ada = await hire("Ada");
  await model(ada.id, true, connected);
  const bo = await hire("Bo");
  await model(bo.id, true, "{}");
  await model(bo.id, false, connected);
  const cy = await hire("Cy");
  await model(cy.id, true, "{}");
  await hire("Di");

  const rows = await roster();
  assert.equal(rows.get("Ada")?.chatReady, true, "a connected active model");
  assert.equal(rows.get("Bo")?.chatReady, true, "a connected model that is not the active one");
  assert.equal(rows.get("Cy")?.chatReady, false, "only a model with no credentials");
  assert.equal(rows.get("Di")?.chatReady, false, "no model at all");
});

test("chatReady is separate from the active model's connection status", async () => {
  const bo = await hire("Bo");
  await model(bo.id, true, "{}");
  await model(bo.id, false, connected);

  const row = (await roster()).get("Bo");
  assert.equal(row?.model?.status, "not_connected", "the active model is not connected");
  assert.equal(row?.chatReady, true, "Chat can still answer from the other model");
});
