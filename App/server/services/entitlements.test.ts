import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Routine } from "../db/entities/Routine.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../test/dbHarness.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "./billing/billingSettings.js";
import {
  PlanLimitError,
  assertCanHireAiEmployee,
  assertRoutineCapacity,
  entitlementsForCompanies,
  getCompanyEntitlements,
  routineCapacityRemaining,
} from "./entitlements.js";
import {
  LICENSE_KEY_SETTING,
  _setVerifyKeysForTest,
  invalidateLicenseCache,
  signLicense,
} from "./license.js";

/**
 * The entitlement matrix (M56): billing off → the instance license decides;
 * billing on → the company's billing row decides, with Free as the fallback
 * for a missing row or a lapsed paid subscription.
 */

const keys = crypto.generateKeyPairSync("ed25519");
const publicKeyB64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

before(async () => {
  await initTestDb();
  _setVerifyKeysForTest([publicKeyB64]);
});

after(async () => {
  _setVerifyKeysForTest(null);
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  // Both instance-level reads memoize for 30s — a previous test's answer must
  // not leak into this one.
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
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

async function seedValidLicense(evaluation = false, expired = false): Promise<void> {
  const key = signLicense(privatePem, {
    v: 1,
    id: crypto.randomUUID(),
    company: "Licensed Co",
    email: null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (expired ? -1000 : 30 * 24 * 3600 * 1000)).toISOString(),
    seats: null,
    evaluation,
  });
  await insert(AppSetting, { key: LICENSE_KEY_SETTING, value: key });
  invalidateLicenseCache();
}

describe("resolution matrix", () => {
  test("billing disabled + no license → community: features off, unlimited limits", async () => {
    const e = await getCompanyEntitlements(testCompanyId());
    assert.deepEqual(e, {
      edition: "community",
      plan: null,
      maxAiEmployees: null,
      maxRoutines: null,
      maxBases: null,
      maxBaseTables: null,
      maxChannels: null,
      maxProjects: null,
      maxTodos: null,
      features: { sso: false, auditLog: false },
    });
  });

  test("billing disabled + valid license → enterprise: features on", async () => {
    await seedValidLicense();
    const e = await getCompanyEntitlements(testCompanyId());
    assert.equal(e.edition, "enterprise");
    assert.equal(e.plan, null);
    assert.deepEqual(e.features, { sso: true, auditLog: true });
    assert.equal(e.maxAiEmployees, null);
  });

  test("billing disabled + expired evaluation license → back to community", async () => {
    await seedValidLicense(true, true);
    const e = await getCompanyEntitlements(testCompanyId());
    assert.equal(e.edition, "community");
    assert.deepEqual(e.features, { sso: false, auditLog: false });
  });

  test("billing enabled + no row → cloud free with enforced limits", async () => {
    await enableBilling();
    const e = await getCompanyEntitlements(testCompanyId());
    assert.deepEqual(e, {
      edition: "cloud",
      plan: "free",
      maxAiEmployees: 1,
      maxRoutines: 2,
      maxBases: 1,
      maxBaseTables: 1,
      maxChannels: 3,
      maxProjects: 1,
      maxTodos: 20,
      features: { sso: false, auditLog: false },
    });
  });

  test("billing enabled + active scale row → features on, unlimited", async () => {
    await enableBilling();
    const cid = testCompanyId();
    await insert(CompanyBilling, { companyId: cid, plan: "scale", status: "active" });
    const e = await getCompanyEntitlements(cid);
    assert.equal(e.edition, "cloud");
    assert.equal(e.plan, "scale");
    assert.deepEqual(e.features, { sso: true, auditLog: true });
    assert.equal(e.maxRoutines, null);
  });

  test("billing enabled + paid row with a dead subscription → treated as free", async () => {
    await enableBilling();
    const cid = testCompanyId();
    await insert(CompanyBilling, { companyId: cid, plan: "growth", status: "canceled" });
    const e = await getCompanyEntitlements(cid);
    assert.equal(e.plan, "free");
    assert.equal(e.maxAiEmployees, 1);
  });

  test("entitlementsForCompanies matches per-company resolution in one batch", async () => {
    await enableBilling();
    const freeCid = testCompanyId();
    const scaleCid = testCompanyId();
    await insert(CompanyBilling, { companyId: scaleCid, plan: "scale", status: "trialing" });
    const map = await entitlementsForCompanies([freeCid, scaleCid]);
    assert.equal(map.get(freeCid)?.plan, "free");
    assert.equal(map.get(scaleCid)?.plan, "scale");
    assert.equal(map.get(scaleCid)?.features.sso, true);
  });
});

describe("limit asserts", () => {
  test("hire: free plan allows the first AI Employee and refuses the second", async () => {
    await enableBilling();
    const cid = testCompanyId();
    await assertCanHireAiEmployee(cid);
    await insert(AIEmployee, { companyId: cid, name: "Ada", slug: "ada", role: "A", soulBody: "" });
    await assert.rejects(assertCanHireAiEmployee(cid), PlanLimitError);
    await assert.rejects(assertCanHireAiEmployee(cid), /Upgrade to Growth to hire more/);
  });

  test("hire: unlimited when billing is disabled, however many employees exist", async () => {
    const cid = testCompanyId();
    await insert(AIEmployee, { companyId: cid, name: "Ada", slug: "ada", role: "A", soulBody: "" });
    await insert(AIEmployee, { companyId: cid, name: "Bo", slug: "bo", role: "B", soulBody: "" });
    await assertCanHireAiEmployee(cid);
  });

  test("routines: capacity counts across ALL the company's employees", async () => {
    await enableBilling();
    const cid = testCompanyId();
    const a = await insert(AIEmployee, {
      companyId: cid,
      name: "Ada",
      slug: "ada",
      role: "A",
      soulBody: "",
    });
    const b = await insert(AIEmployee, {
      companyId: cid,
      name: "Bo",
      slug: "bo",
      role: "B",
      soulBody: "",
    });
    assert.equal(await routineCapacityRemaining(cid), 2);
    await insert(Routine, {
      employeeId: a.id,
      name: "R1",
      slug: "r1",
      cronExpr: "0 9 * * *",
      enabled: true,
      body: "",
    });
    await insert(Routine, {
      employeeId: b.id,
      name: "R2",
      slug: "r2",
      cronExpr: "0 9 * * *",
      enabled: true,
      body: "",
    });
    assert.equal(await routineCapacityRemaining(cid), 0);
    await assert.rejects(assertRoutineCapacity(cid), /unlimited Routines/);
    // Batch form: two at once over a remaining capacity of zero.
    await assert.rejects(assertRoutineCapacity(cid, 2), PlanLimitError);
  });

  test("routines: null capacity (unlimited) when billing is disabled", async () => {
    assert.equal(await routineCapacityRemaining(testCompanyId()), null);
  });
});
