import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { EnterpriseLicense } from "../db/entities/EnterpriseLicense.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { invalidateBillingSettingsCache } from "../services/billing/billingSettings.js";
import {
  _setVerifyKeysForTest,
  invalidateLicenseCache,
  signLicense,
  verifyLicenseKeyWith,
  type LicensePayload,
} from "../services/license.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { adminRouter } from "./admin.js";

/**
 * The Admin → License and Admin → Enterprise Licenses surfaces (M56) with
 * ephemeral Ed25519 keys injected through the `_setVerifyKeysForTest` seam:
 * activation verifies before storing, an expired evaluation is refused, and
 * issuance returns a full key exactly once that then verifies.
 */

const keys = crypto.generateKeyPairSync("ed25519");
const publicKeyB64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  _setVerifyKeysForTest([publicKeyB64]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  _setVerifyKeysForTest(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  const operator = await insert(User, {
    email: "op@example.com",
    name: "Operator",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: true,
    emailVerifiedAt: new Date(),
  });
  actingUserId = operator.id;
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/admin${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function payloadFor(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    company: "Licensed Co",
    email: "buyer@licensed.test",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    seats: 10,
    evaluation: false,
    ...overrides,
  };
}

describe("PUT /api/admin/license", () => {
  test("an invalid key is a 400 and nothing is stored", async () => {
    const bad = await call<{ error: string }>("PUT", "/license", { key: "genlic1.not.real" });
    assert.equal(bad.status, 400);
    const status = await call<{ status: string }>("GET", "/license");
    assert.equal(status.body.status, "none");
  });

  test("a valid key activates: status valid with the payload's facts", async () => {
    const key = signLicense(privatePem, payloadFor());
    const put = await call<{ status: string; companyName: string; seats: number }>(
      "PUT",
      "/license",
      { key },
    );
    assert.equal(put.status, 200);
    assert.equal(put.body.status, "valid");
    assert.equal(put.body.companyName, "Licensed Co");
    assert.equal(put.body.seats, 10);
  });

  test("an expired evaluation key is refused; an expired paid key is accepted as expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const evalKey = signLicense(privatePem, payloadFor({ evaluation: true, expiresAt: past }));
    const refused = await call<{ error: string }>("PUT", "/license", { key: evalKey });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /evaluation license has expired/);

    const paidKey = signLicense(privatePem, payloadFor({ expiresAt: past }));
    const accepted = await call<{ status: string }>("PUT", "/license", { key: paidKey });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "expired");
  });

  test("DELETE clears the license back to none", async () => {
    await call("PUT", "/license", { key: signLicense(privatePem, payloadFor()) });
    const cleared = await call<{ ok: boolean }>("DELETE", "/license");
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.ok, true);
    assert.equal((await call<{ status: string }>("GET", "/license")).body.status, "none");
  });

  test("the whole surface is master-admin only", async () => {
    const civilian = await insert(User, {
      email: "user@example.com",
      name: "U",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = civilian.id;
    assert.equal((await call("GET", "/license")).status, 403);
  });
});

describe("Enterprise license issuance", () => {
  test("issuing without a signing key is a 400", async () => {
    const got = await call<{ error: string }>("POST", "/licenses", {
      companyName: "Acme",
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      evaluation: false,
    });
    assert.equal(got.status, 400);
    assert.match(got.body.error, /signing key/);
  });

  test("configure the signing key, issue, and the returned key verifies", async () => {
    const configured = await call<{ signingConfigured: boolean }>(
      "PUT",
      "/licenses/signing-key",
      { privateKey: privatePem },
    );
    assert.equal(configured.status, 200);
    assert.equal(configured.body.signingConfigured, true);

    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const issued = await call<{
      license: { id: string; companyName: string; keyPreview: string; evaluation: boolean };
      key: string;
    }>("POST", "/licenses", {
      companyName: "Customer Inc",
      email: "it@customer.test",
      expiresAt,
      seats: 50,
      evaluation: false,
    });
    assert.equal(issued.status, 200);
    const issuedKey = issued.body.key;

    // The full key appears once and verifies against the trusted public key.
    const verified = verifyLicenseKeyWith([publicKeyB64], issuedKey);
    assert.ok(verified);
    assert.equal(verified.payload.company, "Customer Inc");
    assert.equal(verified.payload.seats, 50);
    assert.equal(verified.payload.id, issued.body.license.id);

    // Only the masked preview is stored in the registry.
    const row = await AppDataSource.getRepository(EnterpriseLicense).findOneBy({
      id: issued.body.license.id,
    });
    assert.ok(row);
    assert.match(row.keyPreview, /^genlic1\..{4}….{4}$/);
    assert.ok(!row.keyPreview.includes(issuedKey.slice(10, 40)));

    // …and the issued key activates through the ordinary admin PUT.
    const activated = await call<{ status: string; companyName: string }>("PUT", "/license", {
      key: issuedKey,
    });
    assert.equal(activated.body.status, "valid");
    assert.equal(activated.body.companyName, "Customer Inc");

    // The registry lists it, newest first, with the signing flag on.
    const listed = await call<{
      signingConfigured: boolean;
      licenses: Array<{ id: string }>;
    }>("GET", "/licenses");
    assert.equal(listed.body.signingConfigured, true);
    assert.equal(listed.body.licenses[0].id, issued.body.license.id);
  });

  test("a past expiry date and a garbage signing key are refused", async () => {
    const badDate = await call<{ error: string }>("POST", "/licenses", {
      companyName: "Acme",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      evaluation: false,
    });
    assert.equal(badDate.status, 400);

    const badKey = await call<{ error: string }>("PUT", "/licenses/signing-key", {
      privateKey: "not a pem",
    });
    assert.equal(badKey.status, 400);
    assert.match(badKey.body.error, /valid PEM/);
  });

  test("DELETE /licenses/signing-key turns issuance back off", async () => {
    await call("PUT", "/licenses/signing-key", { privateKey: privatePem });
    const cleared = await call<{ signingConfigured: boolean }>(
      "DELETE",
      "/licenses/signing-key",
    );
    assert.equal(cleared.body.signingConfigured, false);
    const listed = await call<{ signingConfigured: boolean }>("GET", "/licenses");
    assert.equal(listed.body.signingConfigured, false);
  });
});
