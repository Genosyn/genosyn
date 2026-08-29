import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";

/**
 * The Free plan's AI Employee cap at the hire route (M56): the second hire is
 * a 402 with the upgrade message, and a template hire seeds only as many
 * Routines as the plan still allows — capping, never failing the hire.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let company: Company;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-plan-limits-"));
  mutableConfig.dataDir = path.join(root, "data");
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
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
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  actingUserId = owner.id;
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthPriceId: "price_growth",
      scalePriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
});

async function hire(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/employees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Free plan AI Employee cap", () => {
  test("the first hire lands; the second is a 402 with the upgrade message", async () => {
    assert.equal((await hire({ name: "Ada", role: "Analyst" })).status, 200);
    const refused = await hire({ name: "Bo", role: "Writer" });
    assert.equal(refused.status, 402);
    assert.equal(
      refused.body.error,
      "Your Free plan includes 1 AI Employee. Upgrade to Growth to hire more.",
    );
  });

  test("without instance billing the cap does not exist", async () => {
    await AppDataSource.getRepository(AppSetting).delete({ key: BILLING_SETTING_KEY });
    invalidateBillingSettingsCache();
    assert.equal((await hire({ name: "Ada", role: "Analyst" })).status, 200);
    assert.equal((await hire({ name: "Bo", role: "Writer" })).status, 200);
  });
});

describe("template hire under the Routine cap", () => {
  test("seeds at most the remaining capacity and never fails the hire", async () => {
    // The paid-marketing template ships 3 Routines; a Free company has
    // capacity for 2 — the hire succeeds and the third is skipped silently.
    const hired = await hire({ name: "Mars", role: "Marketer", templateId: "paid-marketing" });
    assert.equal(hired.status, 200);
    const routines = await AppDataSource.getRepository(Routine).findBy({
      employeeId: String(hired.body.id),
    });
    assert.equal(routines.length, 2);
  });

  test("seeds every template Routine when billing is disabled", async () => {
    await AppDataSource.getRepository(AppSetting).delete({ key: BILLING_SETTING_KEY });
    invalidateBillingSettingsCache();
    const hired = await hire({ name: "Mars", role: "Marketer", templateId: "paid-marketing" });
    assert.equal(hired.status, 200);
    const routines = await AppDataSource.getRepository(Routine).findBy({
      employeeId: String(hired.body.id),
    });
    assert.equal(routines.length, 3);
  });
});
