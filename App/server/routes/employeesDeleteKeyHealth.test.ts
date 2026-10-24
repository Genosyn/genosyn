import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../db/entities/AIModelKeyHealth.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { attachExistingModel, insertEmployeeModel } from "../test/modelFixtures.js";
import { getActiveModel } from "../services/models.js";
import { persistTestSession } from "../test/userSession.js";
import { employeesRouter } from "./employees.js";

/**
 * Letting an AI Employee go detaches its AI Models and nothing more. A model
 * belongs to the company: its credentials, backup keys and every key's health
 * stay, in Settings → AI Models, and a colleague on the same model goes on
 * using it.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl: string;
let ownerId = "";
let companyId = "";

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-employee-key-health-"));
  mutableConfig.dataDir = path.join(root, "data");
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: ownerId, sessionVersion: 0 };
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
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "key-health-owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  ownerId = owner.id;
  const company = await insert(Company, {
    name: "Northwind",
    slug: "northwind",
    ownerId,
  });
  companyId = company.id;
  await insert(Membership, { companyId, userId: ownerId, role: "owner" });
});

async function employeeWithModel(name: string) {
  const employee = await insert(AIEmployee, {
    companyId,
    name,
    slug: name.toLowerCase(),
    role: "Operations",
    soulBody: "",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  for (const keyId of ["primary", "backup-1", "backup-2"])
    await insert(AIModelKeyHealth, { modelId: model.id, keyId, lastUsedAt: new Date() });
  return { employee, model };
}

test("an AI Employee let go is detached; the company keeps the model, its keys and their health", async () => {
  const fired = await employeeWithModel("Nova");
  const kept = await employeeWithModel("Avery");
  const response = await fetch(
    `${baseUrl}/api/companies/${companyId}/employees/${fired.employee.id}`,
    {
      method: "DELETE",
    },
  );
  assert.equal(response.status, 200);
  const health = AppDataSource.getRepository(AIModelKeyHealth);
  assert.equal(await health.countBy({ modelId: fired.model.id }), 3);
  assert.equal(await health.countBy({ modelId: kept.model.id }), 3);
  assert.equal(await AppDataSource.getRepository(AIModel).countBy({ id: fired.model.id }), 1);
  assert.equal(
    await AppDataSource.getRepository(EmployeeModel).countBy({ employeeId: fired.employee.id }),
    0,
  );
  assert.equal((await getActiveModel(kept.employee.id))?.id, kept.model.id);
});

test("a colleague sharing the fired employee's model keeps running on it", async () => {
  const fired = await employeeWithModel("Nova");
  const colleague = await insert(AIEmployee, {
    companyId,
    name: "Avery",
    slug: "avery",
    role: "Operations",
    soulBody: "",
  });
  await attachExistingModel({ employeeId: colleague.id, modelId: fired.model.id, isActive: true });
  const response = await fetch(
    `${baseUrl}/api/companies/${companyId}/employees/${fired.employee.id}`,
    { method: "DELETE" },
  );
  assert.equal(response.status, 200);
  assert.equal((await getActiveModel(colleague.id))?.id, fired.model.id);
  assert.equal(await AppDataSource.getRepository(AIModelKeyHealth).countBy({ modelId: fired.model.id }), 3);
});
