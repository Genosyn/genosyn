import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { auditRouter } from "./audit.js";

/**
 * The Audit log feature gate (M56): reading is 402 until the plan (Scale) or
 * an Enterprise license includes it, with the message phrased for the
 * edition. Writing is untouched — recordAudit isn't behind this router.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let admin: User;

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
  app.use("/api/companies/:cid", auditRouter);
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
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  admin = await insert(User, {
    email: "admin@example.com",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: admin.id });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role });
  actingUserId = admin.id;
});

async function enableBilling(): Promise<void> {
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      scaleMonthlyPriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
}

async function getAudit(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/audit`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("audit feature gate", () => {
  test("billing enabled + free plan → 402 with the Scale-plan message", async () => {
    await enableBilling();
    const got = await getAudit();
    assert.equal(got.status, 402);
    assert.equal(got.body.error, "Audit log is available on the Scale plan.");
  });

  test("billing enabled + active scale row → 200", async () => {
    await enableBilling();
    await insert(CompanyBilling, { companyId: company.id, plan: "scale", status: "active" });
    const got = await getAudit();
    assert.equal(got.status, 200);
    // The endpoint returns `{items, nextCursor}` since M58 gave it filters and
    // a keyset cursor; a bare array left nowhere to put the cursor.
    assert.ok(Array.isArray(got.body.items));
    assert.equal(got.body.nextCursor, null);
  });

  test("self-hosted community → 402 with the Enterprise message", async () => {
    const got = await getAudit();
    assert.equal(got.status, 402);
    assert.equal(got.body.error, "Audit log is available in Genosyn Enterprise.");
  });

  test("the admin role gate still runs before the feature gate", async () => {
    await enableBilling();
    const member = await insert(User, {
      email: "member@example.com",
      name: "M",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
    actingUserId = member.id;
    assert.equal((await getAudit()).status, 403);
  });
});
